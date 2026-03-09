import { Client, ok, simpleFetchHandler } from "@atcute/client";
import type {} from "@atcute/bluesky";
import type { AppBskyActorDefs } from "@atcute/bluesky";
import * as v from "valibot";

export type ProfileViewDetailed = AppBskyActorDefs.ProfileViewDetailed;

const rpc = new Client({
    handler: simpleFetchHandler({ service: "https://public.api.bsky.app" }),
});

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
            did: v.string(),
            url: v.string(),
            name: v.string(),
            description: v.optional(v.nullable(v.string())),
        })),
    }),
});

type ClearskyList = v.InferOutput<typeof ClearskyListsSchema>["data"]["lists"][number];

async function getClearskyListsPage(handle: string, page: number): Promise<ClearskyList[]> {
    await clearskyRateLimit();
    const u = `https://api.clearsky.services/api/v1/anon/get-list/${encodeURIComponent(handle)}${
        page ? `/${page + 1}` : ""
    }`;
    const response = await fetch(u);
    const json = await response.json();
    const parsed = v.parse(ClearskyListsSchema, json);
    return parsed.data.lists;
}

export async function getClearskyLists(handle: string): Promise<ClearskyList[]> {
    const seen = new Set<string>();
    const allLists: ClearskyList[] = [];

    for (let page = 0; page < 3; page++) {
        const lists = await getClearskyListsPage(handle, page);
        for (const list of lists) {
            if (!seen.has(list.url)) {
                seen.add(list.url);
                allLists.push(list);
            }
        }
        if (lists.length < 100) break;
    }

    return allLists;
}

export async function getBlueskyListPurpose(did: string, url: string): Promise<string> {
    const id = url.split("/").at(-1);
    const at = `at://${did}/app.bsky.graph.list/${id}`;
    const res = await ok(rpc.get("app.bsky.graph.getList", { params: { list: at, limit: 1 } }));
    return res.list.purpose;
}

export async function getBlueskyProfile(handle: string): Promise<ProfileViewDetailed> {
    return ok(rpc.get("app.bsky.actor.getProfile", { params: { actor: handle } }));
}

function chunked<A>(array: A[], size: number): A[][] {
    const result = [];
    for (let i = 0; i < array.length; i += size) {
        result.push(array.slice(i, i + size));
    }
    return result;
}

export async function getBlueskyProfiles(dids: string[]): Promise<Map<string, ProfileViewDetailed>> {
    const map = new Map<string, ProfileViewDetailed>();
    for (const chunk of chunked(dids, 25)) {
        const res = await ok(rpc.get("app.bsky.actor.getProfiles", { params: { actors: chunk } }));
        for (const profile of res.profiles) {
            map.set(profile.handle, profile);
            map.set(profile.did, profile);
        }
    }
    return map;
}
