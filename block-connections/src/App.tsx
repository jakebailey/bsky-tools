import "water.css/out/dark.min.css";
import "../../shared.css";
import "./App.css";

import { createRouter, hashHistory, useNavigate, useParams } from "@solidjs/router";
import { type Component, createEffect, createSignal, Errored, For, Match, onCleanup, Show, Switch } from "solid-js";
import {
    avatarFallback,
    cleanHandle,
    getAllFollows,
    getProfile,
    profilePrefix,
    type ProfileViewDetailed,
} from "../../shared/bsky";
import { HandleInput } from "../../shared/HandleInput";
import { ProfileCard } from "../../shared/ProfileCard";
import { type BlockPair, findBlockPairs, type ScanProgress } from "./apis";

type PageState =
    | { status: "idle"; }
    | {
        status: "loading";
        profile: ProfileViewDetailed | null;
        phase: "profile" | "follows" | "blocks";
        current: number;
        total?: number;
        pages: number;
    }
    | { status: "done"; profile: ProfileViewDetailed; followsCount: number; pairs: BlockPair[]; }
    | { status: "error"; error: string; };

function getBlockDirections(pair: BlockPair): { blocker: BlockPair["first"]; blocked: BlockPair["second"]; }[] {
    const directions: { blocker: BlockPair["first"]; blocked: BlockPair["second"]; }[] = [];
    if (pair.firstBlocksSecond) directions.push({ blocker: pair.first, blocked: pair.second });
    if (pair.secondBlocksFirst) directions.push({ blocker: pair.second, blocked: pair.first });
    return directions.sort((a, b) => a.blocker.handle.localeCompare(b.blocker.handle));
}

const Page: Component = () => {
    const navigate = useNavigate();
    const params = useParams<{ handle?: string; }>();
    const [state, setState] = createSignal<PageState>({ status: "idle" });
    let abortController: AbortController | undefined;

    onCleanup(() => abortController?.abort());

    const doSearch = async (actor: string) => {
        abortController?.abort();
        const controller = new AbortController();
        abortController = controller;
        const signal = controller.signal;
        setState({ status: "loading", profile: null, phase: "profile", current: 0, pages: 0 });

        try {
            const profile = await getProfile(actor, signal);
            if (signal.aborted) return;
            setState({
                status: "loading",
                profile,
                phase: "follows",
                current: 0,
                total: profile.followsCount,
                pages: 0,
            });

            const followed = await getAllFollows(profile.did, (progress) => {
                setState((previous) =>
                    previous.status === "loading" && previous.phase === "follows"
                        ? { ...previous, current: progress.current }
                        : previous
                );
            }, signal);
            if (signal.aborted) return;

            setState({
                status: "loading",
                profile,
                phase: "blocks",
                current: 0,
                total: followed.size,
                pages: 0,
            });
            const pairs = await findBlockPairs(followed, (progress: ScanProgress) => {
                setState((previous) =>
                    previous.status === "loading" && previous.phase === "blocks"
                        ? { ...previous, current: progress.checked, pages: progress.pages }
                        : previous
                );
            }, signal);
            if (signal.aborted) return;

            setState({ status: "done", profile, followsCount: followed.size, pairs });
        } catch (error) {
            if (signal.aborted) return;
            controller.abort();
            setState({ status: "error", error: error instanceof Error ? error.message : String(error) });
        }
    };

    createEffect(() => params.handle, (handle) => {
        abortController?.abort();
        if (!handle) {
            setState({ status: "idle" });
            return;
        }

        try {
            const actor = cleanHandle(handle);
            if (actor !== handle) {
                navigate(`/${encodeURIComponent(actor)}`, { replace: true });
                return;
            }
            void doSearch(actor);
        } catch (error) {
            setState({ status: "error", error: error instanceof Error ? error.message : "Invalid handle" });
        }
    });

    return (
        <div>
            <a href=".." class="back-link" rel="external">← Bluesky Tools</a>
            <h1>Block Connections</h1>
            <p class="subtitle">Find accounts you follow who have blocked one another</p>
            <form
                onSubmit={(event) => {
                    event.preventDefault();
                    try {
                        const form = event.target as HTMLFormElement;
                        const actor = cleanHandle(form.handle.value);
                        if (actor) navigate(`/${encodeURIComponent(actor)}`);
                    } catch (error) {
                        setState({ status: "error", error: error instanceof Error ? error.message : "Invalid handle" });
                    }
                }}
            >
                <div class="input-row">
                    <HandleInput
                        id="handle"
                        name="handle"
                        placeholder="Handle, DID, or profile link"
                        value={params.handle || ""}
                        autofocus
                    />
                    <button type="submit">Scan follows</button>
                </div>
            </form>

            <Switch>
                <Match when={state().status === "loading"}>
                    {(() => {
                        const loading = () => state() as PageState & { status: "loading"; };
                        const progressText = () => {
                            const current = loading();
                            if (current.phase === "profile") return "Resolving profile...";
                            if (current.phase === "follows") {
                                return `Fetching followed accounts... ${current.current.toLocaleString()}${
                                    current.total == null ? "" : ` / ${current.total.toLocaleString()}`
                                }`;
                            }
                            return `Scanning blocks... ${current.current.toLocaleString()} / ${
                                current.total?.toLocaleString() ?? 0
                            } accounts checked (${current.pages.toLocaleString()} index pages)`;
                        };

                        return (
                            <>
                                <Show when={loading().profile}>
                                    <ProfileCard profile={loading().profile!} />
                                </Show>
                                <div class="loading">
                                    <p class="progress">{progressText()}</p>
                                    <p class="note">Large follow lists or popular accounts may take a while.</p>
                                </div>
                            </>
                        );
                    })()}
                </Match>
                <Match when={state().status === "error"}>
                    <p class="error">Error: {(state() as PageState & { status: "error"; }).error}</p>
                </Match>
                <Match when={state().status === "done"}>
                    {(() => {
                        const result = () => state() as PageState & { status: "done"; };
                        return (
                            <>
                                <ProfileCard profile={result().profile} />
                                <p class="result-summary">
                                    Found {result().pairs.length.toLocaleString()} block pair
                                    {result().pairs.length === 1 ? "" : "s"} among{" "}
                                    {result().followsCount.toLocaleString()} followed accounts
                                </p>
                                <Show
                                    when={result().pairs.length > 0}
                                    fallback={<p>No indexed block relationships were found among these accounts.</p>}
                                >
                                    <ul class="profile-list block-pair-list">
                                        <For each={result().pairs}>
                                            {(pair) => (
                                                <li class="block-pair">
                                                    <For each={getBlockDirections(pair)}>
                                                        {(direction) => (
                                                            <p>
                                                                <img
                                                                    src={direction.blocker.avatar || avatarFallback}
                                                                    alt=""
                                                                    class="avatar-inline"
                                                                />
                                                                <a href={`${profilePrefix}${direction.blocker.did}`}>
                                                                    @{direction.blocker.handle}
                                                                </a>{" "}
                                                                blocks{" "}
                                                                <img
                                                                    src={direction.blocked.avatar || avatarFallback}
                                                                    alt=""
                                                                    class="avatar-inline"
                                                                />
                                                                <a href={`${profilePrefix}${direction.blocked.did}`}>
                                                                    @{direction.blocked.handle}
                                                                </a>
                                                            </p>
                                                        )}
                                                    </For>
                                                    <span
                                                        class={`block-status ${
                                                            pair.firstBlocksSecond && pair.secondBlocksFirst
                                                                ? "mutual"
                                                                : "one-way"
                                                        }`}
                                                    >
                                                        {pair.firstBlocksSecond && pair.secondBlocksFirst
                                                            ? "Mutual blocks"
                                                            : "One-way block"}
                                                    </span>
                                                </li>
                                            )}
                                        </For>
                                    </ul>
                                </Show>
                                <p class="note">
                                    Results come from Microcosm’s public index. Missing results may reflect index
                                    coverage or update delays.
                                </p>
                            </>
                        );
                    })()}
                </Match>
            </Switch>

            <p class="footer">
                This site queries the Bluesky and Microcosm Constellation APIs directly in your browser. No data is
                stored.
            </p>
        </div>
    );
};

const Router = createRouter({
    history: hashHistory(),
    routes: [{ path: "/:handle?", component: Page }],
});

const App: Component = () => (
    <Errored
        fallback={(error) => (
            <div class="error">
                <h1>Something went wrong</h1>
                <p>{String(error())}</p>
            </div>
        )}
    >
        <Router>{(props) => <>{props.children}</>}</Router>
    </Errored>
);

export default App;
