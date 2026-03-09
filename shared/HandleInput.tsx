import type { AppBskyActorDefs } from "@atcute/bluesky";
import { ok } from "@atcute/client";
import { type Component, createSignal, For, onCleanup, Show } from "solid-js";
import { rpc } from "./bsky";

type ProfileViewBasic = AppBskyActorDefs.ProfileViewBasic;

async function searchTypeahead(query: string, signal?: AbortSignal): Promise<ProfileViewBasic[]> {
    if (!query || query.length < 2) return [];
    const res = await ok(rpc.get("app.bsky.actor.searchActorsTypeahead", {
        params: { q: query, limit: 8 },
        signal,
    }));
    return res.actors;
}

export const HandleInput: Component<{
    id: string;
    name: string;
    placeholder?: string;
    value?: string;
    autofocus?: boolean;
}> = (props) => {
    const [query, setQuery] = createSignal(props.value ?? "");
    const [suggestions, setSuggestions] = createSignal<ProfileViewBasic[]>([]);
    const [showDropdown, setShowDropdown] = createSignal(false);
    const [selectedIndex, setSelectedIndex] = createSignal(-1);
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let abortController: AbortController | undefined;
    let inputRef!: HTMLInputElement;

    onCleanup(() => {
        clearTimeout(debounceTimer);
        abortController?.abort();
    });

    const doSearch = (value: string) => {
        clearTimeout(debounceTimer);
        abortController?.abort();

        // Don't search for DIDs or profile URLs
        const trimmed = value.trim();
        if (!trimmed || trimmed.startsWith("did:") || trimmed.startsWith("https://") || trimmed.startsWith("at://")) {
            setSuggestions([]);
            setShowDropdown(false);
            return;
        }

        debounceTimer = setTimeout(async () => {
            const controller = new AbortController();
            abortController = controller;
            try {
                const results = await searchTypeahead(trimmed.replace(/^@/, ""), controller.signal);
                if (!controller.signal.aborted) {
                    setSuggestions(results);
                    setShowDropdown(results.length > 0);
                    setSelectedIndex(-1);
                }
            } catch {
                if (!controller.signal.aborted) {
                    setSuggestions([]);
                    setShowDropdown(false);
                }
            }
        }, 200);
    };

    const selectSuggestion = (actor: ProfileViewBasic) => {
        setQuery(actor.handle);
        setSuggestions([]);
        setShowDropdown(false);
        inputRef.value = actor.handle;
        // Dispatch input event so forms can react
        inputRef.dispatchEvent(new Event("input", { bubbles: true }));
    };

    const onKeyDown = (e: KeyboardEvent) => {
        const items = suggestions();
        if (!showDropdown() || items.length === 0) return;

        if (e.key === "ArrowDown") {
            e.preventDefault();
            setSelectedIndex((i) => Math.min(i + 1, items.length - 1));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSelectedIndex((i) => Math.max(i - 1, -1));
        } else if (e.key === "Enter" && selectedIndex() >= 0) {
            e.preventDefault();
            selectSuggestion(items[selectedIndex()]);
        } else if (e.key === "Escape") {
            setShowDropdown(false);
        }
    };

    return (
        <div class="handle-input-wrapper">
            <input
                ref={inputRef}
                id={props.id}
                name={props.name}
                type="text"
                placeholder={props.placeholder ?? "Enter handle, DID, or profile link"}
                value={query()}
                autofocus={props.autofocus}
                autocomplete="off"
                onInput={(e) => {
                    const val = e.currentTarget.value;
                    setQuery(val);
                    doSearch(val);
                }}
                onKeyDown={onKeyDown}
                onFocus={() => {
                    if (suggestions().length > 0) setShowDropdown(true);
                }}
                onBlur={() => {
                    // Delay to allow click on suggestion
                    setTimeout(() => setShowDropdown(false), 150);
                }}
            />
            <Show when={showDropdown() && suggestions().length > 0}>
                <ul class="handle-suggestions" role="listbox">
                    <For each={suggestions()}>
                        {(actor, i) => (
                            <li
                                role="option"
                                aria-selected={i() === selectedIndex()}
                                classList={{ "suggestion-selected": i() === selectedIndex() }}
                                onMouseDown={(e) => {
                                    e.preventDefault();
                                    selectSuggestion(actor);
                                }}
                            >
                                <Show when={actor.avatar}>
                                    <img src={actor.avatar!} alt="" class="suggestion-avatar" />
                                </Show>
                                <div class="suggestion-text">
                                    <Show when={actor.displayName}>
                                        <span class="suggestion-name">{actor.displayName}</span>
                                        {" "}
                                    </Show>
                                    <span class="suggestion-handle">@{actor.handle}</span>
                                </div>
                            </li>
                        )}
                    </For>
                </ul>
            </Show>
        </div>
    );
};
