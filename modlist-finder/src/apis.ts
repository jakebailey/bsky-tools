import { ok } from "@atcute/client";
import type { Did } from "@atcute/lexicons/syntax";
import { isDid } from "@atcute/lexicons/syntax";
import type { ActorIdentifier, ResourceUri } from "@atcute/lexicons/syntax";
import * as v from "valibot";
import { type ProfileView, rpc } from "../../shared/bsky";

export { getProfile, getProfiles, type ProfileView, type ProfileViewDetailed } from "../../shared/bsky";

// Simple rate limiter for Clearsky API (5 requests per second)
// https://github.com/ClearskyApp06/clearskyservices/blob/main/api.md#rate-limiting
const clearskyTimestamps: number[] = [];
const clearskyConcurrencyLimit = 5;

async function clearskyRateLimit(): Promise<void> {
    while (true) {
        const now = Date.now();
        while (clearskyTimestamps.length > 0 && clearskyTimestamps[0] < now - 1000) {
            clearskyTimestamps.shift();
        }
        if (clearskyTimestamps.length < clearskyConcurrencyLimit) {
            clearskyTimestamps.push(now);
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000 - (now - clearskyTimestamps[0])));
    }
}

const ClearskyListsSchema = v.object({
    data: v.object({
        lists: v.array(v.object({
            did: v.custom<Did>(isDid),
            url: v.string(),
            name: v.string(),
            description: v.optional(v.nullable(v.string())),
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

export async function getBlueskyListPurpose(did: Did, url: string, signal?: AbortSignal): Promise<string> {
    const at = listAtUri(did, url);
    const res = await ok(rpc.get("app.bsky.graph.getList", { params: { list: at, limit: 1 }, signal }));
    return res.list.purpose;
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
