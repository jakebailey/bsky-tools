import type { ActorIdentifier, Did } from "@atcute/lexicons/syntax";
import { isDid } from "@atcute/lexicons/syntax";
import * as v from "valibot";
import { mapConcurrent, type ProfileView } from "../../shared/bsky";

const plcDirectory = "https://plc.directory";
const miniDocUrl = "https://slingshot.microcosm.blue/xrpc/blue.microcosm.identity.resolveMiniDoc";
const backlinksUrl = "https://constellation.microcosm.blue/xrpc/blue.microcosm.links.getBacklinks";
const blockCollection = "app.bsky.graph.block";
const scanConcurrency = 12;
const requestTimeout = 8_000;
const maxRetryWait = 10_000;

const PlcDocument = v.object({
    id: v.string(),
    service: v.array(v.object({ id: v.string(), type: v.string(), serviceEndpoint: v.unknown() })),
});

const MiniDoc = v.object({ did: v.string(), pds: v.string() });

const BlockPage = v.object({
    records: v.array(v.object({ value: v.object({ subject: v.custom<Did>(isDid) }) })),
    cursor: v.optional(v.string()),
});

const BacklinkPage = v.object({
    records: v.array(v.object({ did: v.custom<Did>(isDid) })),
    cursor: v.nullish(v.string()),
});

export interface BlockPair {
    first: ProfileView;
    second: ProfileView;
    firstBlocksSecond: boolean;
    secondBlocksFirst: boolean;
}

export interface UncheckedAccount {
    profile: ProfileView;
    reason: string;
}

export interface ScanProgress {
    checked: number;
    indexed: number;
    total: number;
    pages: number;
    pairs: BlockPair[];
    unchecked: UncheckedAccount[];
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        signal?.throwIfAborted();
        const timeout = setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
        }, milliseconds);
        const abort = () => {
            clearTimeout(timeout);
            reject(signal?.reason);
        };
        signal?.addEventListener("abort", abort, { once: true });
    });
}

function retryAfterMilliseconds(value: string | null): number {
    if (value === null) return 0;
    const seconds = Number(value);
    const delay = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - Date.now();
    return delay > 0 ? delay : 0;
}

function createJsonReader(signal?: AbortSignal) {
    const hosts = new Map<string, { nextStart: number; retryAt: number; }>();

    return async (url: URL): Promise<unknown> => {
        const hostKey = url.hostname;
        const host = hosts.get(hostKey) ?? { nextStart: 0, retryAt: 0 };
        hosts.set(hostKey, host);

        for (let attempt = 0;; attempt++) {
            while (true) {
                signal?.throwIfAborted();
                const now = performance.now();
                if (host.retryAt - now > maxRetryWait) {
                    throw new Error(`${hostKey} asked the scanner to retry later`);
                }
                const delay = Math.max(host.nextStart, host.retryAt) - now;
                if (delay <= 0) {
                    host.nextStart = now + (url.origin === plcDirectory ? 75 : 110);
                    break;
                }
                await wait(delay, signal);
            }

            const timeout = AbortSignal.timeout(requestTimeout);
            const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
            const response = await fetch(url, {
                signal: requestSignal,
                credentials: "omit",
                redirect: "error",
                referrerPolicy: "no-referrer",
            });
            if (response.ok) return response.json();

            const retryable = response.status === 429 || response.status >= 500;
            if (retryable) {
                const delay = Math.max(500 * 2 ** attempt, retryAfterMilliseconds(response.headers.get("Retry-After")));
                host.retryAt = Math.max(host.retryAt, performance.now() + delay);
            }
            await response.body?.cancel();
            if (!retryable || attempt >= 2) throw new Error(`${hostKey} returned HTTP ${response.status}`);
        }
    };
}

type ReadJson = ReturnType<typeof createJsonReader>;

async function resolvePds(did: Did, readJson: ReadJson): Promise<URL> {
    let endpoint: unknown;
    if (/^did:plc:[a-z2-7]{24}$/.test(did)) {
        const doc = v.parse(PlcDocument, await readJson(new URL(`/${did}`, plcDirectory)));
        if (doc.id !== did) throw new Error("PLC document did not match the account");
        endpoint = doc.service.find((service) =>
            (service.id === "#atproto_pds" || service.id === `${did}#atproto_pds`)
            && service.type === "AtprotoPersonalDataServer"
        )?.serviceEndpoint;
    } else if (did.startsWith("did:web:")) {
        const url = new URL(miniDocUrl);
        url.searchParams.set("identifier", did);
        const doc = v.parse(MiniDoc, await readJson(url));
        if (doc.did !== did) throw new Error("Resolved identity did not match the account");
        endpoint = doc.pds;
    } else {
        throw new Error("Unsupported DID method");
    }

    if (typeof endpoint !== "string") throw new Error("No data server listed for the account");
    return new URL(endpoint);
}

function isBlueskyPds(pds: URL): boolean {
    return pds.protocol === "https:" && !pds.port && !pds.username && !pds.password && pds.pathname === "/"
        && !pds.search && !pds.hash
        && /^(?:[a-z0-9-]+\.){1,2}host\.bsky\.network$/.test(pds.hostname);
}

function batchIndexAuthors(profiles: ProfileView[]): ProfileView[][] {
    const batches: ProfileView[][] = [];
    let batch: ProfileView[] = [];
    let length = 0;
    for (const profile of profiles) {
        const size = new URLSearchParams({ did: profile.did }).toString().length + 1;
        if (length + size > 6_000 && batch.length) {
            batches.push(batch);
            batch = [];
            length = 0;
        }
        batch.push(profile);
        length += size;
    }
    if (batch.length) batches.push(batch);
    return batches;
}

function advanceCursor(url: URL, seen: Set<string>, cursor: string | null | undefined): boolean {
    if (!cursor) return false;
    if (seen.has(cursor)) throw new Error(`${url.hostname} returned a repeated block page cursor`);
    seen.add(cursor);
    url.searchParams.set("cursor", cursor);
    return true;
}

function addBlock(pairs: Map<string, BlockPair>, blocker: ProfileView, blocked: ProfileView): boolean {
    if (blocker.did === blocked.did) return false;
    const blockerFirst = blocker.did < blocked.did;
    const first = blockerFirst ? blocker : blocked;
    const second = blockerFirst ? blocked : blocker;
    const key = `${first.did}\0${second.did}`;
    const previous = pairs.get(key);
    if (blockerFirst ? previous?.firstBlocksSecond : previous?.secondBlocksFirst) return false;
    pairs.set(key, {
        first,
        second,
        firstBlocksSecond: blockerFirst || (previous?.firstBlocksSecond ?? false),
        secondBlocksFirst: !blockerFirst || (previous?.secondBlocksFirst ?? false),
    });
    return true;
}

export async function findBlockPairs(
    followed: Map<ActorIdentifier, ProfileView>,
    onProgress?: (progress: ScanProgress) => void,
    signal?: AbortSignal,
): Promise<ScanProgress> {
    const profiles = [...followed.values()];
    const pairs = new Map<string, BlockPair>();
    const readJson = createJsonReader(signal);
    const total = followed.size;
    const fallback: ProfileView[] = [];
    let checked = 0;
    let indexed = 0;
    let pages = 0;
    let currentPairs: BlockPair[] = [];
    let unchecked: UncheckedAccount[] = [];

    const snapshot = (): ScanProgress => ({ checked, indexed, total, pages, pairs: currentPairs, unchecked });
    const reportPage = (changed: boolean) => {
        pages++;
        if (changed) currentPairs = [...pairs.values()];
        onProgress?.(snapshot());
    };

    await mapConcurrent(profiles, scanConcurrency, async (blocker) => {
        try {
            const pds = await resolvePds(blocker.did, readJson);
            if (!isBlueskyPds(pds)) {
                fallback.push(blocker);
                return;
            }

            const url = new URL("/xrpc/com.atproto.repo.listRecords", pds);
            url.search = new URLSearchParams({ repo: blocker.did, collection: blockCollection, limit: "100" })
                .toString();
            const seen = new Set<string>();
            let cursor;
            do {
                const page = v.parse(BlockPage, await readJson(url));
                signal?.throwIfAborted();
                let changed = false;
                for (const { value: { subject } } of page.records) {
                    const blocked = followed.get(subject);
                    if (blocked && addBlock(pairs, blocker, blocked)) changed = true;
                }
                reportPage(changed);
                cursor = page.cursor;
            } while (advanceCursor(url, seen, cursor));
            checked++;
        } catch {
            signal?.throwIfAborted();
            fallback.push(blocker);
        }
        onProgress?.(snapshot());
    });

    const batches: { authors: Map<Did, ProfileView>; processed: number; error?: string; }[] = batchIndexAuthors(
        fallback,
    )
        .map((authors) => ({
            authors: new Map(authors.map((profile) => [profile.did, profile])),
            processed: 0,
        }));

    await mapConcurrent(batches.flatMap((batch) => profiles.map((blocked) => ({ batch, blocked }))), 4, async ({
        batch,
        blocked,
    }) => {
        try {
            const url = new URL(backlinksUrl);
            url.searchParams.set("subject", blocked.did);
            url.searchParams.set("source", `${blockCollection}:subject`);
            url.searchParams.set("limit", "100");
            for (const did of batch.authors.keys()) url.searchParams.append("did", did);
            const seen = new Set<string>();
            let cursor;
            do {
                const page = v.parse(BacklinkPage, await readJson(url));
                signal?.throwIfAborted();
                let changed = false;
                for (const { did } of page.records) {
                    const blocker = batch.authors.get(did);
                    if (blocker && addBlock(pairs, blocker, blocked)) changed = true;
                }
                reportPage(changed);
                cursor = page.cursor;
            } while (advanceCursor(url, seen, cursor));
        } catch (error) {
            signal?.throwIfAborted();
            batch.error ??= error instanceof Error ? error.message : String(error);
        }
        if (++batch.processed === total) {
            if (batch.error) {
                const reason = `Constellation scan incomplete: ${batch.error}`;
                unchecked = [...unchecked, ...[...batch.authors.values()].map((profile) => ({ profile, reason }))]
                    .sort((a, b) => a.profile.handle.localeCompare(b.profile.handle));
            } else {
                indexed += batch.authors.size;
            }
            onProgress?.(snapshot());
        }
    });

    return snapshot();
}
