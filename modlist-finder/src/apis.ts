import { Data, Effect, Schema } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage";
import { RateLimiter } from "effect/unstable/persistence";

const ClearskyListsSchema = Schema.Struct({
    data: Schema.Struct({
        lists: Schema.Array(Schema.Struct({
            did: Schema.String,
            url: Schema.String,
            name: Schema.String,
            description: Schema.optional(Schema.NullishOr(Schema.String)),
        })),
    }),
});

type ClearskyList = typeof ClearskyListsSchema.Type.data.lists[number];

const decodeClearskyListsSchema = HttpClientResponse.schemaBodyJson(ClearskyListsSchema);

const getClearskyListsWorker = (handle: string, page: number) =>
    Effect.gen(function*() {
        const client = yield* HttpClient.HttpClient;
        const withLimiter = yield* RateLimiter.makeWithRateLimiter;
        const u = `https://api.clearsky.services/api/v1/anon/get-list/${handle}${page ? `/${page + 1}` : ""}`;
        yield* Effect.logDebug(`Fetching ${u}`);
        // https://github.com/ClearskyApp06/clearskyservices/blob/main/api.md#rate-limiting
        const response = yield* withLimiter({ key: "clearsky", limit: 5, window: "1 second", onExceeded: "delay" })(
            client.get(u),
        );
        const lists = yield* decodeClearskyListsSchema(response);
        return lists.data.lists;
    });

export const getClearskyLists = (handle: string) =>
    Effect.gen(function*() {
        const seen = new Set<string>();
        const allLists: ClearskyList[] = [];
        const addLists = (lists: readonly ClearskyList[]) => {
            for (const list of lists) {
                if (seen.has(list.url)) continue;
                seen.add(list.url);
                allLists.push(list);
            }
        };

        // Clearsky returns 100 lists per page
        for (let page = 0; page < 3; page++) {
            if (page === 1) {
                // TODO: binary search through page numbers to see how much work we would have to do
                yield* Effect.logWarning(`More than one page of Clearsky lists...`);
            }

            const lists = yield* getClearskyListsWorker(handle, page);
            yield* Effect.logDebug(`Got ${lists.length} lists`);
            addLists(lists);

            if (lists.length < 100) break;
        }

        return allLists;
    });

const BlueskyErrorSchema = Schema.Struct({
    error: Schema.String,
    message: Schema.String,
});

class BlueskyError extends Data.TaggedError("BlueskyError")<typeof BlueskyErrorSchema.Type> {}

const decodeBlueskyResponse =
    <S extends Schema.Top>(schema: S) => <E>(response: HttpIncomingMessage.HttpIncomingMessage<E>) =>
        Effect.gen(function*() {
            const s = Schema.Union([BlueskyErrorSchema, schema]);
            const json = yield* HttpClientResponse.schemaBodyJson(s)(response);
            if (typeof json === "object" && json !== null && "error" in json) {
                yield* new BlueskyError(json as typeof BlueskyErrorSchema.Type);
            }
            return json as S["Type"];
        });

const BlueskyListsSchema = Schema.Struct({
    list: Schema.Struct({
        purpose: Schema.String,
    }),
});

const decodeBlueskyListsSchema = decodeBlueskyResponse(BlueskyListsSchema);

export const getBlueskyList = (did: string, url: string) =>
    Effect.gen(function*() {
        const client = yield* HttpClient.HttpClient;
        const id = url.split("/").at(-1);
        const at = `at://${did}/app.bsky.lists/${id}`;
        const u = `https://public.api.bsky.app/xrpc/app.bsky.graph.getList?list=${at}`;
        yield* Effect.logDebug(`Fetching ${u}`);
        const response = yield* client.get(u);
        const json = yield* decodeBlueskyListsSchema(response);
        return json.list;
    });

const BlueskyProfileSchema = Schema.Struct({
    did: Schema.String,
    handle: Schema.String,
    displayName: Schema.optional(Schema.NullishOr(Schema.String)),
    avatar: Schema.optional(Schema.NullishOr(Schema.String)),
    createdAt: Schema.String,
    description: Schema.optional(Schema.NullishOr(Schema.String)),
    followersCount: Schema.Number,
    followsCount: Schema.Number,
    postsCount: Schema.Number,
});

const decodeBlueskyProfileSchema = decodeBlueskyResponse(BlueskyProfileSchema);

const BlueskyProfilesSchema = Schema.Struct({
    profiles: Schema.Array(BlueskyProfileSchema),
});

const decodeBlueskyProfilesSchema = decodeBlueskyResponse(BlueskyProfilesSchema);

function chunked<A>(array: A[], size: number): A[][] {
    const result = [];
    for (let i = 0; i < array.length; i += size) {
        result.push(array.slice(i, i + size));
    }
    return result;
}

export const getBlueskyProfiles = (handles: string[]) =>
    Effect.gen(function*() {
        const client = yield* HttpClient.HttpClient;

        const map = new Map<string, typeof BlueskyProfileSchema.Type>();
        for (const chunk of chunked(handles, 25)) {
            const params = chunk.map((handle) => `actors=${handle}`).join("&");
            const u = `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfiles?${params}`;
            yield* Effect.logDebug(`Fetching ${u}`);
            const response = yield* client.get(u);
            const json = yield* decodeBlueskyProfilesSchema(response);
            for (const profile of json.profiles) {
                map.set(profile.handle, profile);
                map.set(profile.did, profile);
            }
        }

        return map;
    });

export const getBlueskyProfile = (handle: string) =>
    Effect.gen(function*() {
        const client = yield* HttpClient.HttpClient;
        const u = `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${handle}`;
        yield* Effect.logDebug(`Fetching ${u}`);
        const response = yield* client.get(u);
        const json = yield* decodeBlueskyProfileSchema(response);
        return json;
    });
