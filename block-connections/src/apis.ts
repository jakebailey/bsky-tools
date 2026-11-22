import type { ActorIdentifier, Did } from "@atcute/lexicons/syntax";
import { isDid } from "@atcute/lexicons/syntax";
import * as v from "valibot";
import { mapConcurrent, type ProfileView } from "../../shared/bsky";

const constellationBacklinksUrl = "https://constellation.microcosm.blue/xrpc/blue.microcosm.links.getBacklinks";
const blockSource = "app.bsky.graph.block:subject";
const maxBacklinksUrlLength = 7_800;
const backlinksConcurrency = 2;
const backlinksRequestInterval = 100;
const maxRateLimitRetries = 5;

const BacklinksSchema = v.object({
    records: v.array(v.object({ did: v.custom<Did>(isDid) })),
    cursor: v.optional(v.nullable(v.string())),
});

export interface BlockPair {
    first: ProfileView;
    second: ProfileView;
    firstBlocksSecond: boolean;
    secondBlocksFirst: boolean;
}

export interface ScanProgress {
    checked: number;
    total: number;
    pages: number;
}

function createBacklinksUrl(subject: Did, linkingDids: Did[], cursor?: string): string {
    const params = new URLSearchParams({
        subject,
        source: blockSource,
        limit: "100",
    });
    if (cursor) params.set("cursor", cursor);
    const didFilters = linkingDids.map(createDidFilter).join("");
    return `${constellationBacklinksUrl}?${params}${didFilters}`;
}

function createDidFilter(did: Did): string {
    return `&did=${encodeURIComponent(did).replaceAll("%3A", ":")}`;
}

function batchLinkingDids(subject: Did, linkingDids: Did[]): Did[][] {
    const batches: Did[][] = [];
    const baseUrlLength = createBacklinksUrl(subject, []).length;
    let urlLength = baseUrlLength;
    let batch: Did[] = [];

    for (const did of linkingDids) {
        const filterLength = createDidFilter(did).length;
        if (urlLength + filterLength > maxBacklinksUrlLength && batch.length > 0) {
            batches.push(batch);
            batch = [];
            urlLength = baseUrlLength;
        }
        batch.push(did);
        urlLength += filterLength;
    }

    if (batch.length > 0) batches.push(batch);
    return batches;
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (milliseconds <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
        }, milliseconds);
        const abort = () => {
            clearTimeout(timeout);
            reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
    });
}

function getRetryAfterMilliseconds(value: string | null): number | undefined {
    if (!value) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const date = Date.parse(value);
    return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function createBacklinksFetcher(): (url: string, signal?: AbortSignal) => Promise<Response> {
    let nextRequestAt = 0;
    let rateLimitedUntil = 0;
    let requestSlot = Promise.resolve();

    const waitForRequestSlot = async (signal?: AbortSignal) => {
        while (true) {
            let requestAt = 0;
            const reservation = requestSlot.then(() => {
                requestAt = Math.max(Date.now(), nextRequestAt, rateLimitedUntil);
                nextRequestAt = requestAt + backlinksRequestInterval;
            });
            requestSlot = reservation.then(() => undefined, () => undefined);
            await reservation;
            await wait(requestAt - Date.now(), signal);
            if (Date.now() >= rateLimitedUntil) return;
        }
    };

    return async (url, signal) => {
        let retries = 0;
        while (true) {
            await waitForRequestSlot(signal);
            const response = await fetch(url, { signal });
            if (response.status !== 429) return response;
            await response.body?.cancel();
            if (retries >= maxRateLimitRetries) {
                throw new Error("Microcosm is rate-limiting scans. Please wait a moment before trying again.");
            }

            const backoff = Math.min(30_000, 1_000 * 2 ** retries);
            const retryAfter = getRetryAfterMilliseconds(response.headers.get("Retry-After")) ?? 0;
            const delay = Math.max(backoff, retryAfter) + Math.random() * 250;
            rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + delay);
            retries++;
        }
    };
}

async function getBlockers(
    subject: Did,
    linkingDids: Did[],
    signal: AbortSignal | undefined,
    onPage: () => void,
    fetchBacklinks: (url: string, signal?: AbortSignal) => Promise<Response>,
): Promise<Did[]> {
    const blockers = new Set<Did>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    do {
        const response = await fetchBacklinks(createBacklinksUrl(subject, linkingDids, cursor), signal);
        if (!response.ok) {
            throw new Error(`Microcosm request failed: ${response.status} ${response.statusText}`);
        }

        const result = v.parse(BacklinksSchema, await response.json());
        for (const record of result.records) {
            blockers.add(record.did);
        }
        onPage();

        cursor = result.cursor ?? undefined;
        if (cursor && seenCursors.has(cursor)) {
            throw new Error("Microcosm returned a repeated cursor while listing block relationships");
        }
        if (cursor) seenCursors.add(cursor);
    } while (cursor);

    return [...blockers];
}

export async function findBlockPairs(
    followed: Map<ActorIdentifier, ProfileView>,
    onProgress?: (progress: ScanProgress) => void,
    signal?: AbortSignal,
): Promise<BlockPair[]> {
    const followedDids: Did[] = [];
    for (const did of followed.keys()) {
        if (!isDid(did)) {
            throw new Error(`Invalid followed DID: ${did}`);
        }
        followedDids.push(did);
    }
    const followedSet = new Set(followedDids);
    const pairs = new Map<string, BlockPair>();
    const queries = followedDids.flatMap((subject) => {
        const batches = batchLinkingDids(subject, followedDids);
        return batches.map((linkingDids) => ({ subject, linkingDids, batchCount: batches.length }));
    });
    const completedBatches = new Map<Did, number>();
    const fetchBacklinks = createBacklinksFetcher();
    let checked = 0;
    let pages = 0;

    await mapConcurrent(queries, backlinksConcurrency, async ({ subject, linkingDids, batchCount }) => {
        const blockers = await getBlockers(subject, linkingDids, signal, () => {
            pages++;
            onProgress?.({ checked, total: followedDids.length, pages });
        }, fetchBacklinks);

        for (const blockerDid of blockers) {
            if (blockerDid === subject || !followedSet.has(blockerDid)) continue;

            const firstDid = blockerDid < subject ? blockerDid : subject;
            const secondDid = blockerDid < subject ? subject : blockerDid;
            const first = followed.get(firstDid);
            const second = followed.get(secondDid);
            if (!first || !second) continue;

            const key = `${firstDid}\0${secondDid}`;
            const pair = pairs.get(key) ?? {
                first,
                second,
                firstBlocksSecond: false,
                secondBlocksFirst: false,
            };
            if (blockerDid === firstDid) {
                pair.firstBlocksSecond = true;
            } else {
                pair.secondBlocksFirst = true;
            }
            pairs.set(key, pair);
        }

        const completed = (completedBatches.get(subject) ?? 0) + 1;
        completedBatches.set(subject, completed);
        if (completed === batchCount) checked++;
        onProgress?.({ checked, total: followedDids.length, pages });
    });

    return [...pairs.values()].sort((a, b) => {
        const aMutual = a.firstBlocksSecond && a.secondBlocksFirst;
        const bMutual = b.firstBlocksSecond && b.secondBlocksFirst;
        return Number(bMutual) - Number(aMutual)
            || a.first.handle.localeCompare(b.first.handle)
            || a.second.handle.localeCompare(b.second.handle);
    });
}
