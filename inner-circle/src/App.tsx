import "water.css/out/dark.min.css";
import "../../shared.css";
import "./App.css";

import { makePersisted } from "@solid-primitives/storage";
import { HashRouter, Route, useNavigate, useParams } from "@solidjs/router";
import { type Component, createEffect, createSignal, ErrorBoundary, For, Match, Show, Switch } from "solid-js";
import { cleanHandle, isEngagementHacker, profilePrefix } from "../../shared/bsky";
import { HandleInput } from "../../shared/HandleInput";
import { ProfileCard } from "../../shared/ProfileCard";
import {
    type ActorIdentifier,
    fetchMutualsSorted,
    getProfile,
    type MutualProfile,
    type ProfileViewDetailed,
    type ProgressInfo,
} from "./apis";

type AppState =
    | { status: "idle"; }
    | { status: "loading"; profile: ProfileViewDetailed | null; progress: ProgressInfo | null; }
    | { status: "done"; profile: ProfileViewDetailed; mutuals: MutualProfile[]; }
    | { status: "error"; error: string; };

const MutualListItem: Component<{ profile: MutualProfile; rank: number; dimHackers: boolean; }> = (props) => (
    <li class="profile-item" classList={{ "engagement-hacker": props.dimHackers && isEngagementHacker(props.profile) }}>
        <div>
            <span class="mutual-rank">{props.rank}</span>
            <Show when={props.profile.avatar}>
                <img src={props.profile.avatar!} alt="" class="avatar-inline" />
            </Show>
            <a href={`${profilePrefix}${props.profile.handle}`}>
                {props.profile.displayName || props.profile.handle}
            </a>{" "}
            <span class="handle">@{props.profile.handle}</span>{" "}
            <span class="follows-count">
                (follows {props.profile.followsCount.toLocaleString()})
            </span>
            <Show when={isEngagementHacker(props.profile)}>
                {" "}
                <span class="hacker-badge" title="Suspected engagement hacker (following 10k+ with high follow ratio)">
                    ⚠️
                </span>
            </Show>
        </div>
    </li>
);

const Page: Component = () => {
    const navigate = useNavigate();
    const params = useParams<{ handle?: string; }>();
    const [state, setState] = createSignal<AppState>({ status: "idle" });
    const [showAll, setShowAll] = createSignal(false);
    const [dimHackers, setDimHackers] = makePersisted(createSignal(true), { name: "dimHackers" });
    let abortController: AbortController | undefined;

    const doFetch = async (handle: ActorIdentifier) => {
        abortController?.abort();
        const controller = new AbortController();
        abortController = controller;
        const signal = controller.signal;
        setState({ status: "loading", profile: null, progress: null });
        setShowAll(false);

        try {
            const profile = await getProfile(handle, signal);
            if (signal.aborted) return;
            setState({ status: "loading", profile, progress: null });

            const result = await fetchMutualsSorted(
                handle,
                (info) => {
                    if (signal.aborted) return;
                    setState((prev) => {
                        if (prev.status !== "loading") return prev;
                        return { ...prev, progress: info };
                    });
                },
                profile,
                signal,
            );
            if (signal.aborted) return;
            setState({ status: "done", profile: result.profile, mutuals: result.mutuals });
        } catch (e) {
            if (signal.aborted) return;
            setState({ status: "error", error: String(e) });
        }
    };

    createEffect(() => {
        const h = params.handle;
        if (h) {
            try {
                const actor = cleanHandle(decodeURIComponent(h));
                if (actor !== decodeURIComponent(h)) {
                    navigate(`/${encodeURIComponent(actor)}`, { replace: true });
                    return;
                }
                doFetch(actor);
            } catch (err) {
                setState({ status: "error", error: err instanceof Error ? err.message : "Invalid handle" });
            }
        } else {
            setState({ status: "idle" });
        }
    });

    const formatProgress = (progress: ProgressInfo | null, handle: string) => {
        if (!progress) return `Resolving ${handle}...`;
        const parts = [];
        if (progress.follows != null) parts.push(`${progress.follows.toLocaleString()} follows fetched`);
        if (progress.mutuals != null) parts.push(`${progress.mutuals.toLocaleString()} mutuals found`);
        return parts.length > 0 ? parts.join(", ") : `Fetching network for ${handle}...`;
    };

    return (
        <div>
            <a href=".." class="back-link" rel="external">← Bluesky Tools</a>
            <h1>Inner Circle</h1>
            <p class="subtitle">
                Find your mutuals who follow the fewest people, the ones where your follow really counts
            </p>
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    try {
                        const form = e.target as HTMLFormElement;
                        const h = cleanHandle(form.handle.value);
                        if (!h) return;
                        setState({ status: "idle" });
                        navigate(`/${encodeURIComponent(h)}`);
                    } catch (err) {
                        setState({ status: "error", error: err instanceof Error ? err.message : "Invalid handle" });
                    }
                }}
            >
                <div class="input-row">
                    <HandleInput
                        id="handle"
                        name="handle"
                        placeholder="Handle, DID, or profile link"
                        value={decodeURIComponent(params.handle || "")}
                        autofocus
                    />
                    <button type="submit">Find Inner Circle</button>
                </div>
            </form>

            <Switch>
                <Match when={state().status === "loading"}>
                    {(() => {
                        const s = () => state() as AppState & { status: "loading"; };
                        return (
                            <>
                                <Show when={s().profile}>
                                    <ProfileCard profile={s().profile!} />
                                </Show>
                                <div class="loading">
                                    <p>Fetching network data...</p>
                                    <p class="progress">
                                        {formatProgress(s().progress, decodeURIComponent(params.handle || ""))}
                                    </p>
                                    <p class="note">This may take a while for accounts with many follows.</p>
                                </div>
                            </>
                        );
                    })()}
                </Match>
                <Match when={state().status === "error"}>
                    <p class="error">Error: {(state() as AppState & { status: "error"; }).error}</p>
                </Match>
                <Match when={state().status === "done"}>
                    {(() => {
                        const s = () => state() as AppState & { status: "done"; };
                        const displayed = () => showAll() ? s().mutuals : s().mutuals.slice(0, 50);
                        return (
                            <>
                                <ProfileCard profile={s().profile} />
                                <p class="result-summary">
                                    {s().mutuals.length.toLocaleString()} mutuals, sorted by how few people they follow
                                </p>

                                <label class="dim-toggle">
                                    <input
                                        type="checkbox"
                                        checked={dimHackers()}
                                        onChange={(e) => setDimHackers(e.currentTarget.checked)}
                                    />{" "}
                                    Dim suspected engagement hackers
                                </label>

                                <ul class="profile-list">
                                    <For each={displayed()}>
                                        {(mutual, i) => (
                                            <MutualListItem
                                                profile={mutual}
                                                rank={i() + 1}
                                                dimHackers={dimHackers()}
                                            />
                                        )}
                                    </For>
                                </ul>
                                <Show when={s().mutuals.length > 50 && !showAll()}>
                                    <button onClick={() => setShowAll(true)}>
                                        Show all {s().mutuals.length.toLocaleString()}
                                    </button>
                                </Show>
                            </>
                        );
                    })()}
                </Match>
            </Switch>

            <p class="footer">
                This site queries the Bluesky API directly in your browser. No data is stored.{" "}
                <a href=".." rel="external">← Back to Bluesky Tools</a>
            </p>
        </div>
    );
};

const App: Component = () => (
    <ErrorBoundary
        fallback={(err) => (
            <div class="error">
                <h1>Something went wrong</h1>
                <p>{String(err)}</p>
            </div>
        )}
    >
        <HashRouter>
            <Route path="/:handle?" component={Page} />
        </HashRouter>
    </ErrorBoundary>
);

export default App;
