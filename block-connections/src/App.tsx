import "water.css/out/dark.min.css";
import "../../shared.css";
import "./App.css";

import { createRouter, hashHistory, useNavigate, useParams } from "@solidjs/router";
import {
    type Component,
    createEffect,
    createMemo,
    createSignal,
    Errored,
    For,
    Match,
    onCleanup,
    Show,
    Switch,
} from "solid-js";
import {
    avatarFallback,
    cleanHandle,
    getAllFollows,
    getProfile,
    profilePrefix,
    type ProfileView,
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
        phase: "profile" | "follows";
        current: number;
        total?: number;
    }
    | { status: "scan"; profile: ProfileViewDetailed; running: boolean; progress: ScanProgress; }
    | { status: "error"; error: string; };

type GroupBy = "blocked" | "blocking";

function groupBlockPairs(pairs: BlockPair[], groupBy: GroupBy) {
    const groups = new Map<ProfileView["did"], {
        profile: ProfileView;
        members: { profile: ProfileView; mutual: boolean; }[];
    }>();
    const add = (blocked: ProfileView, blocker: ProfileView, mutual: boolean) => {
        const [profile, member] = groupBy === "blocked" ? [blocked, blocker] : [blocker, blocked];
        let group = groups.get(profile.did);
        if (!group) {
            group = { profile, members: [] };
            groups.set(profile.did, group);
        }
        group.members.push({ profile: member, mutual });
    };

    for (const pair of pairs) {
        if (pair.firstBlocksSecond) add(pair.second, pair.first, pair.secondBlocksFirst);
        if (pair.secondBlocksFirst) add(pair.first, pair.second, pair.firstBlocksSecond);
    }
    for (const { members } of groups.values()) {
        members.sort((a, b) => a.profile.handle.localeCompare(b.profile.handle));
    }
    return [...groups.values()].sort((a, b) => a.profile.handle.localeCompare(b.profile.handle));
}

const ProfileLink: Component<{ profile: ProfileView; }> = (props) => (
    <>
        <img src={props.profile.avatar || avatarFallback} alt="" class="avatar-inline" />
        <a href={`${profilePrefix}${props.profile.did}`}>@{props.profile.handle}</a>
    </>
);

const Page: Component = () => {
    const navigate = useNavigate();
    const params = useParams<{ handle?: string; }>();
    const [state, setState] = createSignal<PageState>({ status: "idle" });
    const [groupBy, setGroupBy] = createSignal<GroupBy>("blocked");
    const pairs = createMemo(() => {
        const current = state();
        return current.status === "scan" ? current.progress.pairs : [];
    });
    const groups = createMemo(() => groupBlockPairs(pairs(), groupBy()));
    let abortController: AbortController | undefined;

    onCleanup(() => abortController?.abort());

    const doSearch = async (actor: string) => {
        abortController?.abort();
        const controller = new AbortController();
        abortController = controller;
        const signal = controller.signal;
        setState({ status: "loading", profile: null, phase: "profile", current: 0 });

        try {
            const profile = await getProfile(actor, signal);
            if (signal.aborted) return;
            setState({
                status: "loading",
                profile,
                phase: "follows",
                current: 0,
                total: profile.followsCount,
            });

            const followed = await getAllFollows(profile.did, (progress) => {
                if (signal.aborted) return;
                setState((previous) =>
                    previous.status === "loading" && previous.phase === "follows"
                        ? { ...previous, current: progress.current }
                        : previous
                );
            }, signal);
            if (signal.aborted) return;

            setState({
                status: "scan",
                profile,
                running: true,
                progress: { checked: 0, indexed: 0, total: followed.size, pages: 0, pairs: [], unchecked: [] },
            });
            const progress = await findBlockPairs(followed, (progress) => {
                if (!signal.aborted) setState({ status: "scan", profile, running: true, progress });
            }, signal);
            if (signal.aborted) return;

            setState({ status: "scan", profile, running: false, progress });
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
                        abortController?.abort();
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
                            return `Fetching followed accounts... ${current.current.toLocaleString()}${
                                current.total == null ? "" : ` / ${current.total.toLocaleString()}`
                            }`;
                        };

                        return (
                            <>
                                <Show when={loading().profile}>
                                    <ProfileCard profile={loading().profile!} />
                                </Show>
                                <div class="loading">
                                    <p class="progress">{progressText()}</p>
                                </div>
                            </>
                        );
                    })()}
                </Match>
                <Match when={state().status === "error"}>
                    <p class="error">Error: {(state() as PageState & { status: "error"; }).error}</p>
                </Match>
                <Match when={state().status === "scan"}>
                    {(() => {
                        const result = () => state() as Extract<PageState, { status: "scan"; }>;
                        const progress = () => result().progress;
                        return (
                            <>
                                <ProfileCard profile={result().profile} />
                                <p class="progress">
                                    {result().running ? "Scanning blocks... " : ""}
                                    {progress().checked.toLocaleString()} checked directly,{" "}
                                    {progress().indexed.toLocaleString()} checked through Constellation,{" "}
                                    {progress().total.toLocaleString()} accounts total{" "}
                                    ({progress().pages.toLocaleString()} record pages)
                                </p>
                                <p class="result-summary">
                                    Found {progress().pairs.length.toLocaleString()} block pair
                                    {progress().pairs.length === 1 ? "" : "s"} among {progress().total.toLocaleString()}
                                    {" "}
                                    followed accounts
                                </p>
                                <Show when={groups().length > 0}>
                                    <label>
                                        Group by{" "}
                                        <select
                                            value={groupBy()}
                                            onChange={(event) =>
                                                setGroupBy(
                                                    event.currentTarget.value === "blocking" ? "blocking" : "blocked",
                                                )}
                                        >
                                            <option value="blocked">Blocked accounts</option>
                                            <option value="blocking">Blocking accounts</option>
                                        </select>
                                    </label>
                                    <ul class="profile-list block-group-list">
                                        <For each={groups()}>
                                            {(group) => (
                                                <li class="block-group">
                                                    <h2>
                                                        <ProfileLink profile={group.profile} />{" "}
                                                        {groupBy() === "blocked" ? "is blocked by" : "blocks"}
                                                    </h2>
                                                    <ul class="profile-list block-group-members">
                                                        <For each={group.members}>
                                                            {(member) => (
                                                                <li class="profile-item">
                                                                    <ProfileLink profile={member.profile} />
                                                                    <Show when={member.mutual}>
                                                                        {" "}
                                                                        <span class="block-mutual">(mutual)</span>
                                                                    </Show>
                                                                </li>
                                                            )}
                                                        </For>
                                                    </ul>
                                                </li>
                                            )}
                                        </For>
                                    </ul>
                                </Show>
                                <Show when={!result().running && progress().unchecked.length > 0}>
                                    <details>
                                        <summary>
                                            {progress().unchecked.length.toLocaleString()}{" "}
                                            accounts could not be fully checked. Results may be incomplete.
                                        </summary>
                                        <ul class="profile-list">
                                            <For each={progress().unchecked}>
                                                {({ profile, reason }) => (
                                                    <li class="profile-item">
                                                        <a href={`${profilePrefix}${profile.did}`}>@{profile.handle}</a>
                                                        {" "}
                                                        &mdash; {reason}
                                                    </li>
                                                )}
                                            </For>
                                        </ul>
                                    </details>
                                </Show>
                            </>
                        );
                    })()}
                </Match>
            </Switch>

            <p class="footer">
                This site queries Bluesky APIs, Bluesky-operated data servers, the PLC directory, and Microcosm directly
                in your browser. This site does not store scan data. Results cover direct blocks, and Constellation may
                miss some records.
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
