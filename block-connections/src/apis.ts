import type { ActorIdentifier, Did } from "@atcute/lexicons/syntax";
import { isDid } from "@atcute/lexicons/syntax";
import * as v from "valibot";
import { mapConcurrent, type ProfileView } from "../../shared/bsky";

const constellationBacklinksUrl = "https://constellation.microcosm.blue/xrpc/blue.microcosm.links.getBacklinks";
const blockSource = "app.bsky.graph.block:subject";
const maxBacklinksUrlLength = 6_000;
const backlinksConcurrency = 8;

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

function createBacklinksUrl(subject: Did, linkingDids: Did[], cursor?: string): URL {
    const url = new URL(constellationBacklinksUrl);
    url.searchParams.set("subject", subject);
    url.searchParams.set("source", blockSource);
    url.searchParams.set("limit", "100");
    for (const did of linkingDids) {
        url.searchParams.append("did", did);
    }
    if (cursor) url.searchParams.set("cursor", cursor);
    return url;
}

function batchLinkingDids(subject: Did, linkingDids: Did[]): Did[][] {
    const batches: Did[][] = [];
    const url = createBacklinksUrl(subject, []);
    let batch: Did[] = [];

    for (const did of linkingDids) {
        url.searchParams.append("did", did);
        if (url.href.length > maxBacklinksUrlLength && batch.length > 0) {
            url.searchParams.delete("did");
            batches.push(batch);
            batch = [];
            url.searchParams.append("did", did);
        }
        batch.push(did);
    }

    if (batch.length > 0) batches.push(batch);
    return batches;
}

async function getBlockers(
    subject: Did,
    linkingDids: Did[],
    signal: AbortSignal | undefined,
    onPage: () => void,
): Promise<Did[]> {
    const blockers = new Set<Did>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    do {
        const response = await fetch(createBacklinksUrl(subject, linkingDids, cursor), { signal });
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
    let checked = 0;
    let pages = 0;

    await mapConcurrent(queries, backlinksConcurrency, async ({ subject, linkingDids, batchCount }) => {
        const blockers = await getBlockers(subject, linkingDids, signal, () => {
            pages++;
            onProgress?.({ checked, total: followedDids.length, pages });
        });

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
