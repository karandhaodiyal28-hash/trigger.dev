import "dotenv/config";
import { randomBytes } from "node:crypto";
import { nanoid } from "nanoid";
import { Prisma, prisma, webhookPrisma } from "./app/db.server";
import { generateFriendlyId } from "./app/v3/friendlyIdentifiers";

/**
 * LOCAL-ONLY DESIGN SCAFFOLDING. DELETE THIS FILE (and its `webhooks:state` entry in
 * package.json) BEFORE THE WEBHOOKS PR GOES UP FOR REVIEW.
 *
 * Drives the webhook dashboard into UI states that a seeded dataset can't reach on its own,
 * so every visual state can be designed against without running a worker or a provider.
 *
 * Run `db:seed:webhooks` first, then:
 *
 *   pnpm --filter webapp run webhooks:state list             # every URL, grouped by surface
 *   pnpm --filter webapp run webhooks:state handlers         # unlock the handler + Console pages
 *   pnpm --filter webapp run webhooks:state all              # handlers + every edge state
 *   pnpm --filter webapp run webhooks:state <name>           # one edge state
 *   pnpm --filter webapp run webhooks:state reset            # undo what this script did
 *
 * Targets the same environment as `db:seed:webhooks` (first DEVELOPMENT environment
 * local@trigger.dev can see; override with WEBHOOK_SEED_PROJECT).
 */

const APP_ORIGIN = process.env.APP_ORIGIN ?? "http://localhost:3030";

/** Marks the rows this script invents, so `reset` can find and remove exactly those. */
const SCAFFOLD_FILE_PATH_PREFIX = "src/trigger/__ui-states__/";
const SCAFFOLD_METADATA_KEY = "uiStateScaffold";

/** An endpoint only backs a handler page when it has no tenant/external ref. */
function isDefaultEndpoint(endpoint: { endpointTenantId: string; endpointExternalRef: string }) {
  return endpoint.endpointTenantId === "" && endpoint.endpointExternalRef === "";
}

type Scope = {
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
  basePath: string;
};

async function resolveScope() {
  const user = await prisma.user.findFirst({ where: { email: "local@trigger.dev" } });
  if (!user) {
    console.error("User local@trigger.dev not found. Run `pnpm run db:seed` first.");
    process.exit(1);
  }

  const projectName = process.env.WEBHOOK_SEED_PROJECT;
  const runtimeEnv = await prisma.runtimeEnvironment.findFirst({
    where: {
      type: "DEVELOPMENT",
      organization: { members: { some: { userId: user.id } } },
      ...(projectName ? { project: { name: projectName } } : {}),
    },
    include: { project: true, organization: true },
    orderBy: { createdAt: "asc" },
  });
  if (!runtimeEnv) {
    console.error("No DEVELOPMENT environment found. Run `pnpm run db:seed` first.");
    process.exit(1);
  }

  const { organization: org, project } = runtimeEnv;
  const scope: Scope = {
    organizationId: org.id,
    projectId: project.id,
    runtimeEnvironmentId: runtimeEnv.id,
    basePath: `/orgs/${org.slug}/projects/${project.slug}/env/${runtimeEnv.slug}`,
  };

  console.log(`Target: ${org.title} / ${project.name} (env ${runtimeEnv.slug})\n`);
  return scope;
}

function url(scope: Scope, suffix: string) {
  return `${APP_ORIGIN}${scope.basePath}${suffix}`;
}

/**
 * The handler page (and the Console it hosts) resolves a BackgroundWorkerTask with
 * triggerSource WEBHOOK on the environment's CURRENT worker, which for DEVELOPMENT is simply
 * the newest one. The seed script creates endpoints but no worker, so those pages 404.
 *
 * This adds one task per seeded endpoint to the newest existing worker (additive, so the
 * project's real tasks stay listed). Re-run it after any `trigger dev`, which creates a newer
 * worker and takes the "current" slot with it.
 */
async function ensureHandlers(scope: Scope) {
  const endpoints = await webhookPrisma.webhookEndpoint.findMany({
    where: { runtimeEnvironmentId: scope.runtimeEnvironmentId },
    select: { handlerWebhookId: true },
    distinct: ["handlerWebhookId"],
  });
  if (endpoints.length === 0) {
    console.error("No webhook endpoints found. Run `pnpm --filter webapp run db:seed:webhooks`.");
    process.exit(1);
  }

  let worker = await prisma.backgroundWorker.findFirst({
    where: { runtimeEnvironmentId: scope.runtimeEnvironmentId },
    orderBy: { createdAt: "desc" },
  });

  if (!worker) {
    const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    worker = await prisma.backgroundWorker.create({
      data: {
        friendlyId: generateFriendlyId("worker"),
        version: `${stamp}.1`,
        contentHash: `ui-states-${stamp}`,
        projectId: scope.projectId,
        runtimeEnvironmentId: scope.runtimeEnvironmentId,
        metadata: {},
        engine: "V2",
      },
    });
    console.log(`No worker existed, created one (${worker.version}).`);
  }

  let created = 0;
  for (const { handlerWebhookId } of endpoints) {
    const existing = await prisma.backgroundWorkerTask.findFirst({
      where: { workerId: worker.id, slug: handlerWebhookId },
      select: { id: true },
    });
    if (existing) continue;

    await prisma.backgroundWorkerTask.create({
      data: {
        friendlyId: generateFriendlyId("task"),
        slug: handlerWebhookId,
        filePath: `${SCAFFOLD_FILE_PATH_PREFIX}${handlerWebhookId}.ts`,
        triggerSource: "WEBHOOK",
        workerId: worker.id,
        projectId: scope.projectId,
        runtimeEnvironmentId: scope.runtimeEnvironmentId,
      },
    });
    created++;
  }

  console.log(
    `Handlers: ${created} created, ${endpoints.length - created} already present (worker ${worker.version}).`
  );
  console.log(`  ${url(scope, `/webhooks/${endpoints[0].handlerWebhookId}?tab=console`)}`);
}

/**
 * `db:seed:webhooks` clears the Postgres deliveries but leaves the ClickHouse rows behind, so each
 * reseed leaves the previous run's rows orphaned. The list self-hides them (it orders ids out of
 * ClickHouse, then hydrates from Postgres), but a page of ids that all fail to hydrate leaves the
 * endpoint detail Deliveries panel spinning forever. Deleting the orphans keeps the stores honest.
 */
async function cleanOrphans(scope: Scope) {
  const clickhouseUrl =
    process.env.WEBHOOK_DELIVERIES_REPLICATION_CLICKHOUSE_URL ?? process.env.CLICKHOUSE_URL;
  if (!clickhouseUrl) return console.log("Orphans: no ClickHouse URL configured, skipping.");

  const live = await webhookPrisma.webhookDelivery.findMany({
    where: { runtimeEnvironmentId: scope.runtimeEnvironmentId },
    select: { id: true },
  });

  const chUrl = new URL(clickhouseUrl);
  const keep =
    live.length > 0 ? `AND delivery_id NOT IN (${live.map((d) => `'${d.id}'`).join(",")})` : "";
  const query =
    `ALTER TABLE trigger_dev.webhook_deliveries_v1 DELETE ` +
    `WHERE environment_id = '${scope.runtimeEnvironmentId}' ${keep} ` +
    `SETTINGS mutations_sync = 1`;

  const response = await fetch(`${chUrl.protocol}//${chUrl.host}/`, {
    method: "POST",
    headers: chUrl.username
      ? {
          Authorization:
            "Basic " + Buffer.from(`${chUrl.username}:${chUrl.password}`).toString("base64"),
        }
      : {},
    body: query,
  });

  if (!response.ok) {
    console.error(`Orphans: ClickHouse delete failed: ${await response.text()}`);
    return;
  }
  console.log(`Orphans: dropped ClickHouse rows outside the ${live.length} live deliveries.`);
}

/** The DELETING badge, which only otherwise appears mid-deletion. */
async function forceDeleting(scope: Scope) {
  const endpoint = await webhookPrisma.webhookEndpoint.findFirst({
    where: { runtimeEnvironmentId: scope.runtimeEnvironmentId, status: "ACTIVE" },
    orderBy: { createdAt: "desc" },
  });
  if (!endpoint) return console.log("DELETING: no ACTIVE endpoint to convert.");

  await webhookPrisma.webhookEndpoint.update({
    where: { id: endpoint.id },
    data: { status: "DELETING" },
  });
  console.log(`DELETING: ${endpoint.handlerWebhookId}`);
  console.log(`  ${url(scope, `/webhooks/endpoints/${endpoint.friendlyId}`)}`);
}

/**
 * The true (unfiltered) empty state. Only the Postgres rows need to go: the list orders ids out
 * of ClickHouse and then hydrates from Postgres, so rows with no Postgres row never render.
 * Restore with `db:seed:webhooks`.
 */
async function forceEmpty(scope: Scope) {
  const { count } = await webhookPrisma.webhookDelivery.deleteMany({
    where: { runtimeEnvironmentId: scope.runtimeEnvironmentId },
  });
  console.log(`Empty: deleted ${count} deliveries. Restore with \`db:seed:webhooks\`.`);
  console.log(`  ${url(scope, "/webhooks")}`);
}

/** Both "nothing was captured" tab empty states on one delivery detail page. */
async function forceNoPayload(scope: Scope) {
  const delivery = await webhookPrisma.webhookDelivery.findFirst({
    where: { runtimeEnvironmentId: scope.runtimeEnvironmentId, status: "SUCCEEDED" },
    orderBy: { createdAt: "desc" },
  });
  if (!delivery) return console.log("No payload: no SUCCEEDED delivery found.");

  // WebhookDelivery is partitioned on createdAt, so its unique key is compound (id + createdAt).
  // updateMany sidesteps that without having to reconstruct the compound key.
  await webhookPrisma.webhookDelivery.updateMany({
    where: { id: delivery.id },
    data: { parsedEvent: Prisma.DbNull, headers: Prisma.DbNull },
  });
  console.log("No payload: cleared the event body and headers on one delivery.");
  console.log(`  ${url(scope, `/webhooks/deliveries/${delivery.friendlyId}`)}`);
}

/** A FAILED delivery whose Error cell and Error property row fall back to "None". */
async function forceFailedNoError(scope: Scope) {
  const delivery = await webhookPrisma.webhookDelivery.findFirst({
    where: {
      runtimeEnvironmentId: scope.runtimeEnvironmentId,
      status: "FAILED",
      errorMessage: { not: null },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!delivery) return console.log("Failed/no error: no FAILED delivery with a message found.");

  await webhookPrisma.webhookDelivery.updateMany({
    where: { id: delivery.id },
    data: { errorMessage: null },
  });
  console.log("Failed/no error: cleared the message on one FAILED delivery.");
  console.log(`  ${url(scope, `/webhooks/deliveries/${delivery.friendlyId}`)}`);
}

/**
 * Give a tenant-scoped webhook a default-tenant sibling endpoint. Unlocks two states at once:
 * its handler page (which resolves only via an endpoint with an empty tenant + external ref), and
 * the Composer's endpoint picker, which renders only when one webhook has two or more endpoints.
 */
async function forceMultiEndpoint(scope: Scope) {
  const all = await webhookPrisma.webhookEndpoint.findMany({
    where: { runtimeEnvironmentId: scope.runtimeEnvironmentId },
    orderBy: { createdAt: "asc" },
  });
  const slugsWithDefault = new Set(all.filter(isDefaultEndpoint).map((e) => e.handlerWebhookId));
  const orphan = all.find((e) => !slugsWithDefault.has(e.handlerWebhookId));

  if (!orphan) return console.log("Multi-endpoint: every webhook already has a default endpoint.");

  await webhookPrisma.webhookEndpoint.create({
    data: {
      friendlyId: `wh_${nanoid()}`,
      opaqueId: randomBytes(16).toString("base64url"),
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      runtimeEnvironmentId: scope.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      endpointTenantId: "",
      endpointExternalRef: "",
      source: orphan.source,
      handlerWebhookId: orphan.handlerWebhookId,
      routingTarget: orphan.routingTarget as Prisma.InputJsonValue,
      verifierArtifact: orphan.verifierArtifact as Prisma.InputJsonValue,
      secretProvisioning: orphan.secretProvisioning,
      signingSecretKey: orphan.signingSecretKey,
      status: "ACTIVE",
      metadata: { [SCAFFOLD_METADATA_KEY]: true } as Prisma.InputJsonValue,
    },
  });

  console.log(`Multi-endpoint: added a default endpoint for ${orphan.handlerWebhookId}.`);
  console.log(`  ${url(scope, `/webhooks/${orphan.handlerWebhookId}?tab=console`)}`);
}

/** Endpoint whose routingTarget doesn't parse, so Routing Target renders "Unknown". */
async function forceUnknownRouting(scope: Scope) {
  const endpoint = await webhookPrisma.webhookEndpoint.findFirst({
    where: { runtimeEnvironmentId: scope.runtimeEnvironmentId },
    orderBy: { createdAt: "asc" },
  });
  if (!endpoint) return console.log("Unknown routing: no endpoint found.");

  await webhookPrisma.webhookEndpoint.update({
    where: { id: endpoint.id },
    data: { routingTarget: { type: "not-a-real-target" } },
  });
  console.log(`Unknown routing: ${endpoint.handlerWebhookId}`);
  console.log(`  ${url(scope, `/webhooks/endpoints/${endpoint.friendlyId}`)}`);
}

/**
 * Undo what this script changed: drop the invented tasks and put every endpoint back to ACTIVE.
 * Delivery-level edits (cleared payloads, cleared error messages, deleted rows) are content, not
 * state, so those come back with a reseed.
 */
async function reset(scope: Scope) {
  const { count: tasks } = await prisma.backgroundWorkerTask.deleteMany({
    where: {
      runtimeEnvironmentId: scope.runtimeEnvironmentId,
      filePath: { startsWith: SCAFFOLD_FILE_PATH_PREFIX },
    },
  });
  const { count: endpoints } = await webhookPrisma.webhookEndpoint.updateMany({
    where: { runtimeEnvironmentId: scope.runtimeEnvironmentId, status: "DELETING" },
    data: { status: "ACTIVE" },
  });
  // `unknown-routing` corrupts a routingTarget on purpose; put every endpoint back to the
  // task target the seed gives it.
  const seeded = await webhookPrisma.webhookEndpoint.findMany({
    where: { runtimeEnvironmentId: scope.runtimeEnvironmentId },
    select: { id: true, handlerWebhookId: true },
  });
  for (const endpoint of seeded) {
    await webhookPrisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { routingTarget: { type: "task", taskId: endpoint.handlerWebhookId } },
    });
  }

  const { count: siblings } = await webhookPrisma.webhookEndpoint.deleteMany({
    where: {
      runtimeEnvironmentId: scope.runtimeEnvironmentId,
      metadata: { path: [SCAFFOLD_METADATA_KEY], equals: true },
    },
  });
  console.log(
    `Reset: removed ${tasks} scaffold tasks and ${siblings} scaffold endpoints, restored ${endpoints} endpoints to ACTIVE.`
  );
  console.log("Re-run `db:seed:webhooks` to restore delivery content.");
}

async function list(scope: Scope) {
  const [endpoints, statuses] = await Promise.all([
    webhookPrisma.webhookEndpoint.findMany({
      where: { runtimeEnvironmentId: scope.runtimeEnvironmentId },
      orderBy: { createdAt: "asc" },
    }),
    webhookPrisma.$queryRaw<Array<{ status: string; friendlyId: string }>>`
      SELECT DISTINCT ON (status) status, "friendlyId"
      FROM "WebhookDelivery"
      WHERE "runtimeEnvironmentId" = ${scope.runtimeEnvironmentId}
      ORDER BY status, "createdAt" DESC
    `,
  ]);

  console.log("DELIVERIES LIST");
  console.log(`  all                ${url(scope, "/webhooks")}`);
  console.log(`  empty (filtered)   ${url(scope, "/webhooks?deliveryId=whd_no_such_delivery")}`);
  console.log(`  test sends only    ${url(scope, "/webhooks?test=only")}`);

  console.log("\nDELIVERY DETAIL (one per status)");
  for (const { status, friendlyId } of statuses) {
    console.log(`  ${status.padEnd(18)} ${url(scope, `/webhooks/deliveries/${friendlyId}`)}`);
  }
  console.log(`  aged out/bogus     ${url(scope, "/webhooks/deliveries/whd_no_such_delivery")}`);

  console.log("\nENDPOINT DETAIL");
  for (const endpoint of endpoints) {
    const notes = [
      endpoint.status !== "ACTIVE" ? endpoint.status.toLowerCase() : undefined,
      endpoint.signingSecretKey ? undefined : "no secret",
      endpoint.endpointTenantId ? "multi-tenant" : undefined,
    ].filter(Boolean);
    const label = notes.length > 0 ? `${endpoint.source} (${notes.join(", ")})` : endpoint.source;
    console.log(
      `  ${label.padEnd(30)} ${url(scope, `/webhooks/endpoints/${endpoint.friendlyId}`)}`
    );
  }

  console.log("\nHANDLER + CONSOLE (needs `webhooks:state handlers`)");
  const withDefault = new Set(endpoints.filter(isDefaultEndpoint).map((e) => e.handlerWebhookId));
  const slugs = [...new Set(endpoints.map((e) => e.handlerWebhookId))];
  const reachable = slugs.filter((slug) => withDefault.has(slug));

  for (const slug of reachable) {
    console.log(`  ${slug.padEnd(30)} ${url(scope, `/webhooks/${slug}`)}`);
  }
  for (const tab of ["console", "runs", "endpoints"]) {
    const label = `${reachable[0]} (${tab})`;
    console.log(`  ${label.padEnd(30)} ${url(scope, `/webhooks/${reachable[0]}?tab=${tab}`)}`);
  }

  // A handler page resolves through a default-tenant endpoint only, so a webhook that exists
  // solely under a tenant 404s until `webhooks:state multi-endpoint` gives it a default sibling.
  for (const slug of slugs.filter((slug) => !withDefault.has(slug))) {
    console.log(`  ${slug.padEnd(30)} 404s: tenant-scoped only, run \`multi-endpoint\``);
  }
}

const EDGE_STATES = {
  deleting: forceDeleting,
  "no-payload": forceNoPayload,
  "failed-no-error": forceFailedNoError,
  "unknown-routing": forceUnknownRouting,
  "multi-endpoint": forceMultiEndpoint,
} as const;

async function main() {
  const command = process.argv[2];
  const scope = await resolveScope();

  switch (command) {
    case "list":
      await list(scope);
      break;
    case "handlers":
      await ensureHandlers(scope);
      break;
    case "empty":
      await forceEmpty(scope);
      break;
    case "clean-orphans":
      await cleanOrphans(scope);
      break;
    case "reset":
      await reset(scope);
      await cleanOrphans(scope);
      break;
    case "all":
      await ensureHandlers(scope);
      for (const apply of Object.values(EDGE_STATES)) {
        await apply(scope);
      }
      break;
    default: {
      const edge = EDGE_STATES[command as keyof typeof EDGE_STATES];
      if (edge) {
        await edge(scope);
        break;
      }
      console.error(
        `Unknown command "${command ?? ""}".\n\nCommands:\n` +
          `  list             every URL, grouped by surface\n` +
          `  handlers         unlock the handler + Console pages\n` +
          `  all              handlers + every edge state below\n` +
          `  ${Object.keys(EDGE_STATES).join("\n  ")}\n` +
          `  empty            delete every delivery (restore with db:seed:webhooks)\n` +
          `  clean-orphans    drop ClickHouse rows a reseed left behind (run after db:seed:webhooks)\n` +
          `  reset            undo this script's changes`
      );
      process.exit(1);
    }
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
