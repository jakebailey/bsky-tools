import "water.css/out/dark.min.css";
import "../../shared.css";
import "./App.css";

import { makePersisted } from "@solid-primitives/storage";
import { HashRouter, Route, useNavigate, useParams } from "@solidjs/router";
import { type Component, createEffect, createResource, createSignal, For, Match, Show, Switch } from "solid-js";
import { isEngagementHacker, profilePrefix } from "../../shared/bsky";
import { ProfileCard } from "../../shared/ProfileCard";
import { RichText } from "../../shared/RichText";
import {
    type ClearskyList,
    getBlueskyListPurpose,
    getClearskyLists,
    getProfile,
    getProfiles,
    type ProfileViewDetailed,
} from "./apis";

interface ListEntry {
    profile: ProfileViewDetailed;
    list: ClearskyList;
}

async function processLists(clearskyLists: ClearskyList[]): Promise<ListEntry[]> {
    const results = await Promise.allSettled(
        clearskyLists.map(async (list) => {
            const purpose = await getBlueskyListPurpose(list.did, list.url);
            return { list, purpose };
        }),
    );

    const modClearskyLists = results
        .filter((r): r is PromiseFulfilledResult<{ list: ClearskyList; purpose: string; }> =>
            r.status === "fulfilled" && r.value.purpose === "app.bsky.graph.defs#modlist"
        )
        .map((r) => r.value.list);

    let profiles: Map<string, ProfileViewDetailed> | undefined;
    try {
        profiles = await getProfiles(modClearskyLists.map((list) => list.did));
    } catch {
        // ignore
    }

    if (!profiles?.size) {
        return [];
    }

    const lists: ListEntry[] = [];
    for (const list of modClearskyLists) {
        const listProfile = profiles.get(list.did);
        if (!listProfile || listProfile.handle === "handle.invalid") {
            continue;
        }
        lists.push({ profile: listProfile, list });
    }

    return lists;
}

async function doWork(queryHandle: string) {
    const profile = await getProfile(queryHandle);
    const clearskyResult = await getClearskyLists(queryHandle);
    const lists = await processLists(clearskyResult.lists);

    lists.sort((a, b) => (b.profile.followersCount ?? 0) - (a.profile.followersCount ?? 0));

    return { profile, lists, hasMore: clearskyResult.hasMore, nextPage: clearskyResult.nextPage };
}

const Page: Component = () => {
    const navigate = useNavigate();
    const params = useParams<{ handle?: string | undefined; }>();
    const [info] = createResource(() => params.handle || undefined, doWork);
    const [dimHackers, setDimHackers] = makePersisted(createSignal(true), { name: "dimHackers" });
    const [extraLists, setExtraLists] = createSignal<ListEntry[]>([]);
    const [hasMore, setHasMore] = createSignal(false);
    const [nextPage, setNextPage] = createSignal(0);
    const [loadingMore, setLoadingMore] = createSignal(false);

    const allLists = () => {
        const base = info()?.lists ?? [];
        return [...base, ...extraLists()];
    };

    // Reset extra lists and sync hasMore when resource resolves
    createEffect(() => {
        const data = info();
        if (data) {
            setExtraLists([]);
            setHasMore(data.hasMore);
            setNextPage(data.nextPage);
        }
    });

    const loadMore = async () => {
        const handle = params.handle;
        if (!handle || loadingMore()) return;
        setLoadingMore(true);
        try {
            const result = await getClearskyLists(decodeURIComponent(handle), nextPage());
            const newLists = await processLists(result.lists);
            newLists.sort((a, b) => (b.profile.followersCount ?? 0) - (a.profile.followersCount ?? 0));
            setExtraLists((prev) => [...prev, ...newLists]);
            setHasMore(result.hasMore);
            setNextPage(result.nextPage);
        } finally {
            setLoadingMore(false);
        }
    };
    return (
        <div>
            <a href=".." class="back-link" rel="external">← Bluesky Tools</a>
            <h1>Bluesky Moderation List Finder</h1>
            <br />
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    const value = (e.target as HTMLFormElement).handle.value.trim();
                    if (!value) return;
                    navigate(`/${encodeURIComponent(value)}`);
                }}
            >
                <input
                    id="handle"
                    name="handle"
                    type="text"
                    placeholder="Enter handle, DID, or profile link"
                    value={decodeURIComponent(params.handle || "")}
                    autofocus
                />
                <button type="submit">Search</button>
            </form>

            <Show when={info.state === "ready"}>
                <ProfileCard profile={info()!.profile} />
            </Show>

            <Switch>
                <Match when={info.loading}>
                    <p>Loading...</p>
                </Match>
                <Match when={info.error}>
                    <span>Error: {`${info.error}`}</span>
                </Match>
                <Match when={info()}>
                    <label class="dim-toggle">
                        <input
                            type="checkbox"
                            checked={dimHackers()}
                            onChange={(e) => setDimHackers(e.currentTarget.checked)}
                        />{" "}
                        Dim suspected engagement hackers
                    </label>
                    <p>{allLists().length} moderation lists</p>
                    <ul class="profile-list">
                        <For each={allLists()}>
                            {(list) => (
                                <li
                                    class="profile-item"
                                    classList={{
                                        "engagement-hacker": dimHackers() && isEngagementHacker(list.profile),
                                    }}
                                >
                                    <Show when={list.profile.avatar}>
                                        <img
                                            src={list.profile.avatar!}
                                            alt=""
                                            class="avatar-small"
                                        />
                                    </Show>
                                    <div>
                                        <a href={list.list.url}>{list.list.name}</a> by{" "}
                                        <a href={`${profilePrefix}${list.profile.handle}`}>
                                            {list.profile.handle}
                                        </a>{" "}
                                        <span class="follower-count">
                                            ({list.profile.followersCount} followers)
                                        </span>
                                        <Show when={isEngagementHacker(list.profile)}>
                                            {" "}
                                            <span
                                                class="hacker-badge"
                                                title="Suspected engagement hacker (following 10k+ with high follow ratio)"
                                            >
                                                ⚠️
                                            </span>
                                        </Show>
                                        <Show when={list.list.description}>
                                            <p>
                                                <RichText text={list.list.description!} />
                                            </p>
                                        </Show>
                                    </div>
                                </li>
                            )}
                        </For>
                    </ul>
                    <Show when={hasMore()}>
                        <button onClick={loadMore} disabled={loadingMore()}>
                            {loadingMore() ? "Loading..." : "Show more lists"}
                        </button>
                    </Show>
                </Match>
            </Switch>

            <p class="footer">
                This site queries the Bluesky and Clearsky APIs directly in your browser. No data is stored. Note that
                all content is generated from those APIs; I can't be responsible for anything that shows up here, and
                list creator follower count is not necessarily a good measure of quality or trustworthiness. Use these
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
