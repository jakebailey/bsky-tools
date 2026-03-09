import "water.css/out/dark.min.css";
import "../../shared.css";
import "./App.css";

import { makePersisted } from "@solid-primitives/storage";
import { HashRouter, Route, useNavigate, useParams } from "@solidjs/router";
import { type Component, createEffect, createSignal, For, Match, Show, Switch } from "solid-js";
import { isEngagementHacker, mapConcurrent, profilePrefix } from "../../shared/bsky";
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

async function processLists(
    clearskyLists: ClearskyList[],
    onProgress?: (checked: number, total: number) => void,
    signal?: AbortSignal,
): Promise<ListEntry[]> {
    let checked = 0;
    const results = await mapConcurrent(clearskyLists, 10, async (list) => {
        try {
            const purpose = await getBlueskyListPurpose(list.did, list.url, signal);
            return { list, purpose, ok: true as const };
        } catch {
            return { list, purpose: "", ok: false as const };
        } finally {
            checked++;
            onProgress?.(checked, clearskyLists.length);
        }
    });

    const modClearskyLists = results
        .filter((r) => r.ok && r.purpose === "app.bsky.graph.defs#modlist")
        .map((r) => r.list);

    let profiles: Map<string, ProfileViewDetailed> | undefined;
    try {
        profiles = await getProfiles(modClearskyLists.map((list) => list.did), signal);
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

async function doWork(
    queryHandle: string,
    onProgress: (msg: string, profile?: ProfileViewDetailed) => void,
    signal?: AbortSignal,
) {
    onProgress("Resolving profile...");
    const profile = await getProfile(queryHandle, signal);
    onProgress("Fetching lists from Clearsky...", profile);
    const clearskyResult = await getClearskyLists(queryHandle, 0, 3, signal);
    onProgress(`Checking ${clearskyResult.lists.length} lists...`, profile);
    const lists = await processLists(clearskyResult.lists, (checked, total) => {
        onProgress(`Checking lists... ${checked}/${total}`, profile);
    }, signal);
    onProgress("Fetching list creator profiles...", profile);

    lists.sort((a, b) => (b.profile.followersCount ?? 0) - (a.profile.followersCount ?? 0));

    return { profile, lists, hasMore: clearskyResult.hasMore, nextPage: clearskyResult.nextPage };
}

type PageState =
    | { status: "idle"; }
    | { status: "loading"; progress: string; profile?: ProfileViewDetailed; }
    | { status: "done"; profile: ProfileViewDetailed; lists: ListEntry[]; hasMore: boolean; nextPage: number; }
    | { status: "error"; error: string; };

const Page: Component = () => {
    const navigate = useNavigate();
    const params = useParams<{ handle?: string | undefined; }>();
    const [state, setState] = createSignal<PageState>({ status: "idle" });
    let abortController: AbortController | undefined;
    const [dimHackers, setDimHackers] = makePersisted(createSignal(true), { name: "dimHackers" });
    const [extraLists, setExtraLists] = createSignal<ListEntry[]>([]);
    const [loadingMore, setLoadingMore] = createSignal(false);

    const allLists = () => {
        const s = state();
        const base = s.status === "done" ? s.lists : [];
        return [...base, ...extraLists()];
    };

    const doSearch = async (handle: string) => {
        abortController?.abort();
        const controller = new AbortController();
        abortController = controller;
        setState({ status: "loading", progress: "Resolving profile..." });
        setExtraLists([]);
        try {
            const result = await doWork(handle, (msg, profile) => {
                setState({ status: "loading", progress: msg, profile });
            }, controller.signal);
            if (controller.signal.aborted) return;
            setState({
                status: "done",
                profile: result.profile,
                lists: result.lists,
                hasMore: result.hasMore,
                nextPage: result.nextPage,
            });
        } catch (e) {
            if (controller.signal.aborted) return;
            setState({ status: "error", error: String(e) });
        }
    };

    // React to URL changes (back/forward navigation, initial load, form submit)
    createEffect(() => {
        const handle = params.handle;
        if (handle) {
            doSearch(decodeURIComponent(handle));
        } else {
            setState({ status: "idle" });
        }
    });

    const loadMore = async () => {
        const s = state();
        if (s.status !== "done" || loadingMore()) return;
        setLoadingMore(true);
        try {
            const result = await getClearskyLists(
                decodeURIComponent(params.handle!),
                s.nextPage,
                3,
                abortController?.signal,
            );
            const newLists = await processLists(result.lists, undefined, abortController?.signal);
            newLists.sort((a, b) => (b.profile.followersCount ?? 0) - (a.profile.followersCount ?? 0));
            setExtraLists((prev) => [...prev, ...newLists]);
            setState({ ...s, hasMore: result.hasMore, nextPage: result.nextPage });
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

            <Show
                when={(() => {
                    const s = state();
                    return s.status === "loading" && s.profile
                        ? s.profile
                        : s.status === "done"
                        ? s.profile
                        : undefined;
                })()}
            >
                {(profile) => <ProfileCard profile={profile()} />}
            </Show>

            <Switch>
                <Match when={state().status === "loading"}>
                    <div class="loading">
                        <p class="progress">
                            {(state() as PageState & { status: "loading"; }).progress}
                        </p>
                    </div>
                </Match>
                <Match when={state().status === "error"}>
                    <p class="error">
                        Error: {(state() as PageState & { status: "error"; }).error}
                    </p>
                </Match>
                <Match when={state().status === "done"}>
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
                    <Show
                        when={(() => {
                            const s = state();
                            return s.status === "done" && s.hasMore;
                        })()}
                    >
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
