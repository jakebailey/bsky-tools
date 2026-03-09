import "water.css/out/dark.min.css";
import "./App.css";

import { HashRouter, Route, useNavigate, useParams } from "@solidjs/router";
import { Effect, References } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { RateLimiter } from "effect/unstable/persistence";
import { type Component, createResource, For, Match, Show, Switch } from "solid-js";
import { getBlueskyList, getBlueskyProfile, getBlueskyProfiles, getClearskyLists } from "./apis";

// handle should already be URL safe
const doWork = (queryHandle: string) =>
    Effect.gen(function*() {
        yield* Effect.log(`Fetching profile for ${queryHandle}`);
        const profile = yield* getBlueskyProfile(queryHandle);
        yield* Effect.log(`Fetching lists for ${queryHandle}`);
        const clearskyLists = yield* getClearskyLists(queryHandle);

        const [, clearskyListsWithPurpose] = yield* Effect.partition(
            clearskyLists,
            (list) => getBlueskyList(list.did, list.url).pipe(Effect.map(({ purpose }) => ({ list, purpose }))),
            { concurrency: 20 },
        );

        const modClearskyLists = clearskyListsWithPurpose.filter(
            (list) => list.purpose === "app.bsky.graph.defs#modlist",
        ).map(({ list }) => list);

        const profiles = yield* Effect.orElseSucceed(
            getBlueskyProfiles(modClearskyLists.map((list) => list.did)),
            () => undefined,
        );

        if (!profiles?.size) {
            return { profile, lists: [] };
        }

        const lists = [];
        for (const list of modClearskyLists) {
            const profile = profiles.get(list.did);
            if (!profile || profile.handle === "handle.invalid") {
                continue;
            }
            lists.push({ profile, list });
        }

        // sort descending by followers count
        lists.sort((a, b) => b.profile.followersCount - a.profile.followersCount);

        return { profile, lists };
    }).pipe(
        Effect.scoped,
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(RateLimiter.layer),
        Effect.provide(RateLimiter.layerStoreMemory),
        Effect.provideService(References.MinimumLogLevel, "Debug"),
    );

const fetchInfo = (handle: string) => Effect.runPromise(doWork(handle));

const profilePrefix = "https://bsky.app/profile/";

const Page: Component = () => {
    const navigate = useNavigate();
    const params = useParams<{ handle?: string | undefined; }>();
    const [info] = createResource(() => params.handle || undefined, fetchInfo);
    return (
        <div>
            <h1>Bluesky Moderation List Finder</h1>
            <br />
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    let value = (e.target as HTMLFormElement).handle.value;
                    value = value.trim();
                    if (value.startsWith(profilePrefix)) {
                        value = value.slice(profilePrefix.length);
                        value = value.split("/")[0];
                    }
                    if (value.startsWith("@")) {
                        value = value.slice(1);
                    }
                    if (value.startsWith("at://")) {
                        value = value.slice("at://".length);
                    }
                    navigate(`/${encodeURIComponent(value)}`);
                }}
            >
                <input
                    id="handle"
                    type="text"
                    placeholder="Enter handle, DID, or profile link"
                    value={decodeURIComponent(params.handle || "")}
                    autofocus
                />
                <button type="submit">Search</button>
            </form>

            <Show when={params.handle}>
                <blockquote>
                    <p>
                        <a href={`${profilePrefix}${params.handle}`}>{params.handle}</a>
                        <Show when={info.state === "ready"}>
                            {" "}
                            ({info()!.profile.displayName})
                        </Show>
                    </p>
                    <Show when={info.state === "ready"}>
                        <p>{info()!.profile.description}</p>
                    </Show>
                </blockquote>
            </Show>

            <Switch>
                <Match when={info.loading}>
                    <p>Loading...</p>
                </Match>
                <Match when={info.error}>
                    <span>Error: {`${info.error}`}</span>
                </Match>
                <Match when={info()}>
                    <p>{info()!.lists.length} moderation lists</p>
                    <ul>
                        <For each={info()!.lists}>
                            {(list) => (
                                <li>
                                    <p>
                                        <a href={list.list.url}>{list.list.name}</a> by{" "}
                                        <a href={`${profilePrefix}${list.profile.handle}`}>
                                            {list.profile.handle}
                                        </a>{" "}
                                        ({list.profile.followersCount} followers)
                                    </p>
                                    <Show when={list.list.description}>
                                        <p>{list.list.description}</p>
                                    </Show>
                                </li>
                            )}
                        </For>
                    </ul>
                </Match>
            </Switch>

            <p>
                This site queries the Bluesky and Clearsky APIs directly in your browser. No data is stored. Note that
                all content is generated from those APIs; I can't be responsible for anything that shows up here, and
                list creator follower count is not neccesarily a good measure of quality or trustworthiness. Use these
                lists at your own risk.
            </p>
        </div>
    );
};

const App: Component = () => {
    return (
        <HashRouter root={(props) => <>{props.children}</>}>
            <Route path="/:handle?" component={Page} />
        </HashRouter>
    );
};

export default App;
