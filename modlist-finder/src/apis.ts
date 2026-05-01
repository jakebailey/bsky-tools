import { ok } from "@atcute/client";
import type { Did } from "@atcute/lexicons/syntax";
import { isDid } from "@atcute/lexicons/syntax";
import type { ActorIdentifier, ResourceUri } from "@atcute/lexicons/syntax";
import * as v from "valibot";
import { type ProfileView, rpc } from "../../shared/bsky";

export { getProfile, getProfiles, type ProfileView, type ProfileViewDetailed } from "../../shared/bsky";

// Queue-based rate limiter for Clearsky API (5 requests per second)
// https://github.com/ClearskyApp06/clearskyservices/blob/main/api.md#rate-limiting
const clearskyConcurrencyLimit = 5;
const clearskyTimestamps: number[] = [];
let clearskyQueue: Promise<void> = Promise.resolve();

function clearskyRateLimit(): Promise<void> {
    clearskyQueue = clearskyQueue.then(async () => {
        while (true) {
            const now = Date.now();
            while (clearskyTimestamps.length > 0 && clearskyTimestamps[0] < now - 1000) {
                clearskyTimestamps.shift();
            }
            if (clearskyTimestamps.length < clearskyConcurrencyLimit) {
                clearskyTimestamps.push(Date.now());
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 1000 - (now - clearskyTimestamps[0])));
        }
    });
    return clearskyQueue;
}

const ClearskyListsSchema = v.object({
    data: v.object({
        lists: v.array(v.object({
            did: v.custom<Did>(isDid),
            url: v.string(),
            name: v.string(),
            description: v.optional(v.nullable(v.string())),
            date_added: v.optional(v.nullable(v.string())),
        })),
    }),
});

type ClearskyList = v.InferOutput<typeof ClearskyListsSchema>["data"]["lists"][number];

async function getClearskyListsPage(handle: string, page: number, signal?: AbortSignal): Promise<ClearskyList[]> {
    await clearskyRateLimit();
    const u = `https://api.clearsky.services/api/v1/anon/get-list/${encodeURIComponent(handle)}${
        page ? `/${page + 1}` : ""
    }`;
    const response = await fetch(u, { signal });
    const json = await response.json();
    const parsed = v.parse(ClearskyListsSchema, json);
    return parsed.data.lists;
}

export type { ClearskyList };

export interface ClearskyListsResult {
    lists: ClearskyList[];
    hasMore: boolean;
    nextPage: number;
}

export async function getClearskyLists(
    handle: string,
    startPage = 0,
    maxPages = 3,
    signal?: AbortSignal,
): Promise<ClearskyListsResult> {
    const seen = new Set<string>();
    const allLists: ClearskyList[] = [];
    let hasMore = false;

    for (let page = startPage; page < startPage + maxPages; page++) {
        const lists = await getClearskyListsPage(handle, page, signal);
        for (const list of lists) {
            if (!seen.has(list.url)) {
                seen.add(list.url);
                allLists.push(list);
            }
        }
        if (lists.length < 100) break;
        if (page === startPage + maxPages - 1) {
            hasMore = true;
        }
    }

    return { lists: allLists, hasMore, nextPage: startPage + maxPages };
}

export function listAtUri(did: Did, url: string): ResourceUri {
    const id = url.split("/").at(-1);
    return `at://${did}/app.bsky.graph.list/${id}` as ResourceUri;
}

export interface ListLabel {
    val: string;
    src: string;
}

export async function getBlueskyListPurpose(
    did: Did,
    url: string,
    signal?: AbortSignal,
): Promise<{ purpose: string; listItemCount?: number; latestItemAt?: string; labels?: ListLabel[]; }> {
    const at = listAtUri(did, url);
    const res = await ok(rpc.get("app.bsky.graph.getList", { params: { list: at, limit: 1 }, signal }));
    // The most recently added item is returned first; extract its timestamp from the TID rkey.
    const latestItemUri = res.items[0]?.uri;
    const latestItemAt = latestItemUri ? tidToDate(latestItemUri.split("/").at(-1)!) : undefined;
    return {
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
    onProgress: (checked: number, matches: ProfileView[]) => void,
    signal?: AbortSignal,
): Promise<ProfileView[]> {
    const matches: ProfileView[] = [];
    let cursor: string | undefined;
    let checked = 0;
    do {
        const res = await ok(rpc.get("app.bsky.graph.getList", {
            params: { list: listUri, limit: 100, cursor },
            signal,
        }));
        for (const item of res.items) {
            checked++;
            if (item.subject.did !== excludeDid && followDids.has(item.subject.did)) {
                matches.push(item.subject);
            }
        }
        onProgress(checked, matches);
        cursor = res.cursor;
    } while (cursor);
    return matches;
}
