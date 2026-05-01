import "water.css/out/dark.min.css";
import "../../shared.css";
import "./App.css";

import { makePersisted } from "@solid-primitives/storage";
import { HashRouter, Route, useNavigate, useParams } from "@solidjs/router";
import { type Component, createEffect, createSignal, ErrorBoundary, For, Match, Show, Switch } from "solid-js";
import { avatarFallback, cleanHandle, isEngagementHacker, mapConcurrent, profilePrefix } from "../../shared/bsky";
import { HandleInput } from "../../shared/HandleInput";
import { ProfileCard } from "../../shared/ProfileCard";
import { RichText } from "../../shared/RichText";
import {
    checkListForFollows,
    type ClearskyList,
    getBlueskyListPurpose,
    getClearskyLists,
    getFollows,
    getProfile,
    getProfiles,
    listAtUri,
    type ListLabel,
    type ProfileView,
    type ProfileViewDetailed,
} from "./apis";

interface ListEntry {
    profile: ProfileViewDetailed;
    list: ClearskyList;
    listItemCount?: number;
    addedAt?: string;
    latestItemAt?: string;
    labels?: ListLabel[];
}

async function processLists(
    clearskyLists: ClearskyList[],
    onProgress?: (checked: number, total: number) => void,
    signal?: AbortSignal,
): Promise<ListEntry[]> {
    let checked = 0;
    const results = await mapConcurrent(clearskyLists, 10, async (list) => {
        try {
            const { purpose, listItemCount, latestItemAt, labels } = await getBlueskyListPurpose(list.did, list.url, signal);
            return { list, purpose, listItemCount, latestItemAt, labels, ok: true as const };
        } catch {
            return { list, purpose: "", listItemCount: undefined, ok: false as const };
        } finally {
            checked++;
            onProgress?.(checked, clearskyLists.length);
        }
    });

    const modClearskyLists = results
        .filter((r) => r.ok && r.purpose === "app.bsky.graph.defs#modlist");

    let profiles: Map<string, ProfileViewDetailed> | undefined;
    try {
        profiles = await getProfiles(modClearskyLists.map((r) => r.list.did), signal);
    } catch {
        // ignore
    }

    if (!profiles?.size) {
        return [];
    }

    const lists: ListEntry[] = [];
    for (const r of modClearskyLists) {
        const listProfile = profiles.get(r.list.did);
        if (!listProfile || listProfile.handle === "handle.invalid") {
            continue;
        }
        lists.push({
            profile: listProfile,
            list: r.list,
            listItemCount: r.listItemCount,
            addedAt: r.list.date_added ?? undefined,
            latestItemAt: r.latestItemAt,
            labels: r.labels,
        });
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
    const clearskyResult = await getClearskyLists(profile.handle, 0, 3, signal);
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

    // Follow-check state
    const [viewerHandle, setViewerHandle] = makePersisted(createSignal(""), { name: "viewerHandle" });
    const [viewerFollows, setViewerFollows] = createSignal<Set<string>>();
    const [followsLoading, setFollowsLoading] = createSignal(false);
    const [followsError, setFollowsError] = createSignal<string>();
    const [listChecks, setListChecks] = createSignal<
        Record<string, {
            status: "checking" | "done";
            checked: number;
            matches: ProfileView[];
        }>
    >({});
    let followsAbort: AbortController | undefined;

    const loadFollows = async () => {
        const handle = viewerHandle();
        if (!handle) return;
        followsAbort?.abort();
        const controller = new AbortController();
        followsAbort = controller;
        setFollowsLoading(true);
        setFollowsError(undefined);
        setListChecks({});
        try {
            const cleaned = cleanHandle(handle);
            const follows = await getFollows(cleaned, controller.signal);
            if (controller.signal.aborted) return;
            setViewerFollows(follows);
        } catch (e) {
            if (controller.signal.aborted) return;
            setFollowsError(e instanceof Error ? e.message : String(e));
        } finally {
            setFollowsLoading(false);
        }
    };

    const checkList = async (list: ClearskyList) => {
        const follows = viewerFollows();
        if (!follows) return;
        const key = list.url;
        setListChecks((prev) => ({
            ...prev,
            [key]: { status: "checking", checked: 0, matches: [] },
        }));
        try {
            const uri = listAtUri(list.did, list.url);
            const s = state();
            const excludeDid = s.status === "done" ? s.profile.did : undefined;
            await checkListForFollows(uri, follows, excludeDid, (checked, matches) => {
                setListChecks((prev) => ({
                    ...prev,
                    [key]: { ...prev[key], checked, matches: [...matches] },
                }));
            }, abortController?.signal);
            setListChecks((prev) => ({
                ...prev,
                [key]: { ...prev[key], status: "done" },
            }));
        } catch (e) {
            if (!(e instanceof DOMException && e.name === "AbortError")) {
                setListChecks((prev) => ({
                    ...prev,
                    [key]: { ...prev[key], status: "done" },
                }));
            }
        }
    };

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
                s.profile.handle,
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
                    try {
                        const value = cleanHandle((e.target as HTMLFormElement).handle.value);
                        if (!value) return;
                        navigate(`/${encodeURIComponent(value)}`);
                    } catch (err) {
                        setState({ status: "error", error: err instanceof Error ? err.message : "Invalid handle" });
                    }
                }}
            >
                <HandleInput
                    id="handle"
                    name="handle"
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

                    <div class="follows-check">
                        <p class="follows-check-label">Check lists for people you follow</p>
                        <form
                            class="follows-form"
                            onSubmit={(e) => {
                                e.preventDefault();
                                loadFollows();
                            }}
                        >
                            <HandleInput
                                id="viewer-handle"
                                name="viewer-handle"
                                placeholder="Your handle"
                                value={viewerHandle()}
                                onChange={setViewerHandle}
                            />
                            <button type="submit" disabled={followsLoading() || !viewerHandle()}>
                                {followsLoading() ? "Loading..." : "Load follows"}
                            </button>
                        </form>
                        <Show when={followsError()}>
                            <p class="error">{followsError()}</p>
                        </Show>
                        <Show when={viewerFollows()}>
                            {(follows) => <p class="follows-loaded">{follows().size.toLocaleString()} follows loaded
                            </p>}
                        </Show>
                    </div>

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
                                    <div>
                                        <a href={list.list.url}>{list.list.name}</a> by{" "}
                                        <img
                                            src={list.profile.avatar || avatarFallback}
                                            alt=""
                                            class="avatar-inline"
                                        />
                                        <a href={`${profilePrefix}${list.profile.handle}`}>
                                            {list.profile.handle}
                                        </a>{" "}
                                        <span class="follower-count">
                                            ({list.profile.followersCount?.toLocaleString()} followers)
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
                                        <Show when={list.labels?.some((l) => l.val === "!hide")}>
                                            {" "}
                                            <span
                                                class="hidden-badge"
                                                title="This list is hidden by Bluesky's moderation"
                                            >
                                                🚫 Hidden by Bluesky
                                            </span>
                                        </Show>
                                        <div class="list-meta">
                                            <Show when={list.listItemCount != null}>
                                                <span class="list-size">
                                                    {list.listItemCount!.toLocaleString()} members
                                                </span>
                                            </Show>
                                            <Show when={list.latestItemAt}>
                                                <span class="date-added">
                                                    last updated{" "}
                                                    {new Date(list.latestItemAt!).toLocaleDateString(undefined, {
                                                        year: "numeric",
                                                        month: "short",
                                                        day: "numeric",
                                                    })}
                                                </span>
                                            </Show>
                                            <Show when={list.addedAt}>
                                                {(() => {
                                                    const s = state();
                                                    const handle = s.status === "done" ? s.profile.handle : undefined;
                                                    return (
                                                        <span class="date-added">
                                                            {handle ? `@${handle}` : "user"} added{" "}
                                                            {new Date(list.addedAt!).toLocaleDateString(undefined, {
                                                                year: "numeric",
                                                                month: "short",
                                                                day: "numeric",
                                                            })}
                                                        </span>
                                                    );
                                                })()}
                                            </Show>
                                        </div>
                                        <Show when={list.list.description}>
                                            <p>
                                                <RichText text={list.list.description!} />
                                            </p>
                                        </Show>
                                        <Show when={viewerFollows()}>
                                            {(_follows) => {
                                                const check = () => listChecks()[list.list.url];
                                                return (
                                                    <div class="follow-check-row">
                                                        <Show
                                                            when={check()}
                                                            fallback={
                                                                <button
                                                                    class="check-follows-btn"
                                                                    onClick={() => checkList(list.list)}
                                                                >
                                                                    Check for follows
                                                                </button>
                                                            }
                                                        >
                                                            {(c) => (
                                                                <>
                                                                    <Show when={c().status === "checking"}>
                                                                        <span class="check-progress">
                                                                            Checked {c().checked.toLocaleString()}...
                                                                        </span>
                                                                    </Show>
                                                                    <Show
                                                                        when={c().matches.length > 0}
                                                                        fallback={
                                                                            <Show when={c().status === "done"}>
                                                                                <span class="no-follows-found">
                                                                                    No follows found
                                                                                </span>
                                                                            </Show>
                                                                        }
                                                                    >
                                                                        <span class="follows-found">
                                                                            {c().matches.length}{" "}
                                                                            follow{c().matches.length !== 1 ? "s" : ""}
                                                                            {" "}
                                                                            found:
                                                                        </span>{" "}
                                                                        <For each={c().matches}>
                                                                            {(m, i) => (
                                                                                <>
                                                                                    <Show when={i() > 0}>,{" "}</Show>
                                                                                    <a
                                                                                        href={`${profilePrefix}${m.handle}`}
                                                                                    >
                                                                                        {m.displayName || m.handle}
                                                                                    </a>
                                                                                </>
                                                                            )}
                                                                        </For>
                                                                    </Show>
                                                                </>
                                                            )}
                                                        </Show>
                                                    </div>
                                                );
                                            }}
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
        <ErrorBoundary
            fallback={(err) => (
                <div class="error">
                    <h1>Something went wrong</h1>
                    <p>{String(err)}</p>
                </div>
            )}
        >
            <HashRouter root={(props) => <>{props.children}</>}>
                <Route path="/:handle?" component={Page} />
            </HashRouter>
        </ErrorBoundary>
    );
};

export default App;
