import { ok } from "@atcute/client";
import type { Did } from "@atcute/lexicons/syntax";
import { isDid } from "@atcute/lexicons/syntax";
import type { ActorIdentifier, ResourceUri } from "@atcute/lexicons/syntax";
import * as v from "valibot";
import {
    chunked,
    getProfiles as getProfilesShared,
    mapConcurrent,
    type ProfileViewDetailed,
    rpc,
} from "../../shared/bsky";

export { getProfile, getProfiles, type ProfileView, type ProfileViewDetailed } from "../../shared/bsky";

const constellationUrl = "https://constellation.microcosm.blue/xrpc/blue.microcosm.links.getBacklinks";
const constellationManyToManyCountsUrl =
    "https://constellation.microcosm.blue/xrpc/blue.microcosm.links.getManyToManyCounts";
const listItemCollection = "app.bsky.graph.listitem";

const ConstellationBacklinksSchema = v.object({
    records: v.array(v.object({
        did: v.custom<Did>(isDid),
        collection: v.literal(listItemCollection),
        rkey: v.string(),
    })),
    cursor: v.nullable(v.string()),
});

const ListItemRecordSchema = v.object({
    value: v.object({
        $type: v.literal(listItemCollection),
        subject: v.custom<Did>(isDid),
        list: v.string(),
        createdAt: v.optional(v.string()),
    }),
});

const ConstellationManyToManyCountsSchema = v.object({
    counts_by_other_subject: v.array(v.object({
        subject: v.custom<Did>(isDid),
        total: v.number(),
        distinct: v.number(),
    })),
    cursor: v.optional(v.nullable(v.string())),
});

export interface ListMembership {
    uri: ResourceUri;
    addedAt?: string;
}

export interface AtprotoList extends ListMembership {
    did: Did;
    url: string;
    name: string;
    description?: string;
}

function parseListUri(value: string): ResourceUri {
    const match = /^at:\/\/([^/]+)\/app\.bsky\.graph\.list\/([^/]+)$/.exec(value);
    if (!match || !isDid(match[1])) {
        throw new Error(`Invalid list URI: ${value}`);
    }
    return value as ResourceUri;
}

async function getConstellationPage(
    did: Did,
    cursor?: string,
    signal?: AbortSignal,
): Promise<{ lists: ListMembership[]; cursor?: string; }> {
    const u = new URL(constellationUrl);
    u.searchParams.set("subject", did);
    u.searchParams.set("source", `${listItemCollection}:subject`);
    u.searchParams.set("limit", "100");
    if (cursor) u.searchParams.set("cursor", cursor);
    const response = await fetch(u, { signal });
    if (!response.ok) {
        throw new Error(`Constellation request failed: ${response.status} ${response.statusText}`);
    }
    const json = await response.json();
    const parsed = v.parse(ConstellationBacklinksSchema, json);
    const listItems = await mapConcurrent(parsed.records, 10, async (record) => {
        const recordUrl = new URL("https://public.api.bsky.app/xrpc/com.atproto.repo.getRecord");
        recordUrl.searchParams.set("repo", record.did);
        recordUrl.searchParams.set("collection", record.collection);
        recordUrl.searchParams.set("rkey", record.rkey);
        const recordResponse = await fetch(recordUrl, { signal });
        if (recordResponse.status === 400 || recordResponse.status === 404) {
            return undefined;
        }
        if (!recordResponse.ok) {
            throw new Error(`List item request failed: ${recordResponse.status} ${recordResponse.statusText}`);
        }
        const listItem = v.parse(ListItemRecordSchema, await recordResponse.json()).value;
        if (listItem.subject !== did) {
            throw new Error(`List item subject did not match ${did}`);
        }
        return {
            uri: parseListUri(listItem.list),
            addedAt: listItem.createdAt,
        } satisfies ListMembership;
    });
    const lists: ListMembership[] = [];
    for (const item of listItems) {
        if (item) lists.push(item);
    }
    return {
        lists,
        cursor: parsed.cursor ?? undefined,
    };
}

export interface ConstellationListsResult {
    lists: ListMembership[];
    hasMore: boolean;
    nextCursor?: string;
}

export async function getConstellationLists(
    did: Did,
    startCursor: string | undefined,
    maxPages = 3,
    signal?: AbortSignal,
): Promise<ConstellationListsResult> {
    const seen = new Set<string>();
    const allLists: ListMembership[] = [];
    let cursor = startCursor;

    for (let page = 0; page < maxPages; page++) {
        const result = await getConstellationPage(did, cursor, signal);
        const { lists } = result;
        for (const list of lists) {
            if (!seen.has(list.uri)) {
                seen.add(list.uri);
                allLists.push(list);
            }
        }
        cursor = result.cursor;
        if (!cursor) break;
    }

    return { lists: allLists, hasMore: cursor !== undefined, nextCursor: cursor };
}

export function listAtUri(list: AtprotoList): ResourceUri {
    return list.uri;
}

export interface ListLabel {
    val: string;
    src: string;
}

export async function getBlueskyList(
    membership: ListMembership,
    signal?: AbortSignal,
): Promise<{
    list: AtprotoList;
    purpose: string;
    listItemCount?: number;
    latestItemAt?: string;
    labels?: ListLabel[];
}> {
    const res = await ok(rpc.get("app.bsky.graph.getList", {
        params: { list: membership.uri, limit: 1 },
        signal,
    }));
    // The most recently added item is returned first; extract its timestamp from the TID rkey.
    const latestItemUri = res.items[0]?.uri;
    const latestItemAt = latestItemUri ? tidToDate(latestItemUri.split("/").at(-1)!) : undefined;
    const listUri = parseListUri(res.list.uri);
    const listId = listUri.split("/").at(-1)!;
    return {
        list: {
            ...membership,
            uri: listUri,
            did: res.list.creator.did,
            url: `https://bsky.app/profile/${res.list.creator.did}/lists/${listId}`,
            name: res.list.name,
            description: res.list.description,
        },
        purpose: res.list.purpose,
        listItemCount: res.list.listItemCount,
        latestItemAt,
        labels: res.list.labels?.map((l) => ({ val: l.val, src: l.src })),
    };
}

const S32_CHARS = "234567abcdefghijklmnopqrstuvwxyz";

function tidToDate(tid: string): string | undefined {
    if (tid.length !== 13) return undefined;
    let n = 0n;
    for (const ch of tid) {
        const i = S32_CHARS.indexOf(ch);
        if (i === -1) return undefined;
        n = n * 32n + BigInt(i);
    }
    // Upper bits are microseconds since epoch; lower 10 bits are clock ID.
    const microseconds = n >> 10n;
    return new Date(Number(microseconds / 1000n)).toISOString();
}

export async function getFollows(actor: ActorIdentifier, signal?: AbortSignal): Promise<Set<string>> {
    const dids = new Set<string>();
    let cursor: string | undefined;
    do {
        const res = await ok(rpc.get("app.bsky.graph.getFollows", {
            params: { actor, limit: 100, cursor },
            signal,
        }));
        for (const follow of res.follows) {
            dids.add(follow.did);
        }
        cursor = res.cursor;
    } while (cursor);
    return dids;
}

export async function checkListForFollows(
    listUri: ResourceUri,
    followDids: Set<string>,
    excludeDid: string | undefined,
    onProgress: (checked: number, matches: ProfileViewDetailed[]) => void,
    signal?: AbortSignal,
): Promise<ProfileViewDetailed[]> {
    const candidateDids: Did[] = [];
    for (const did of followDids) {
        if (did === excludeDid) continue;
        if (!isDid(did)) {
            throw new Error(`Invalid followed DID: ${did}`);
        }
        candidateDids.push(did);
    }

    const matches = new Map<Did, ProfileViewDetailed>();
    let checked = 0;
    await mapConcurrent(chunked(candidateDids, 100), 5, async (batch) => {
        const u = new URL(constellationManyToManyCountsUrl);
        u.searchParams.set("subject", listUri);
        u.searchParams.set("source", `${listItemCollection}:list`);
        u.searchParams.set("pathToOther", "subject");
        u.searchParams.set("limit", batch.length.toString());
        for (const did of batch) {
            u.searchParams.append("otherSubject", did);
        }

        const response = await fetch(u, { signal });
        if (!response.ok) {
            throw new Error(`Constellation request failed: ${response.status} ${response.statusText}`);
        }
        const parsed = v.parse(ConstellationManyToManyCountsSchema, await response.json());
        if (parsed.cursor) {
            throw new Error("Constellation returned an unexpected cursor for a bounded membership query");
        }

        const batchSet = new Set(batch);
        const matchDids: Did[] = [];
        for (const count of parsed.counts_by_other_subject) {
            if (!batchSet.has(count.subject)) {
                throw new Error(`Constellation returned an unexpected list member: ${count.subject}`);
            }
            if (count.total > 0) {
                matchDids.push(count.subject);
            }
        }

        if (matchDids.length > 0) {
            const profiles = await getProfilesShared(matchDids, signal);
            for (const did of matchDids) {
                const profile = profiles.get(did);
                if (profile) matches.set(did, profile);
            }
        }

        checked += batch.length;
        onProgress(checked, [...matches.values()]);
    });
    return [...matches.values()];
}
