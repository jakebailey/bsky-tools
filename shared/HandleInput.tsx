import type { AppBskyActorDefs } from "@atcute/bluesky";
import { ok } from "@atcute/client";
import { type Component, createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { avatarFallback, rpc } from "./bsky";

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
    onChange?: (value: string) => void;
}> = (props) => {
    const [query, setQuery] = createSignal(props.value ?? "");
    const [suggestions, setSuggestions] = createSignal<ProfileViewBasic[]>([]);
    const [showDropdown, setShowDropdown] = createSignal(false);

    createEffect(() => {
        setQuery(props.value ?? "");
    });
    const [selectedIndex, setSelectedIndex] = createSignal(-1);
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let abortController: AbortController | undefined;
    let inputRef!: HTMLInputElement;
    let justSelected = false;

    onCleanup(() => {
        clearTimeout(debounceTimer);
        abortController?.abort();
    });

    const doSearch = (value: string) => {
        clearTimeout(debounceTimer);
        abortController?.abort();

        if (justSelected) {
            justSelected = false;
            return;
        }

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
                    // Filter out exact matches
                    const normalized = trimmed.replace(/^@/, "").toLowerCase();
                    const filtered = results.filter((a) => a.handle.toLowerCase() !== normalized);
                    setSuggestions(filtered);
                    setShowDropdown(filtered.length > 0);
                    setSelectedIndex(-1);
                }
            } catch {
                if (!controller.signal.aborted) {
                    setSuggestions([]);
                    setShowDropdown(false);
                }
            }
        }, 80);
    };

    const selectSuggestion = (actor: ProfileViewBasic) => {
        justSelected = true;
        setQuery(actor.handle);
        setSuggestions([]);
        setShowDropdown(false);
        inputRef.value = actor.handle;
        props.onChange?.(actor.handle);
        inputRef.dispatchEvent(new Event("input", { bubbles: true }));
        // Auto-submit if all handle inputs in the form have values
        const form = inputRef.closest("form");
        if (form) {
            const inputs = form.querySelectorAll<HTMLInputElement>(".handle-input-wrapper input");
            if ([...inputs].every((input) => input.value.trim())) {
                form.requestSubmit();
            }
        }
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

    const handleSelect = (e: MouseEvent | TouchEvent, actor: ProfileViewBasic) => {
        e.preventDefault();
        selectSuggestion(actor);
    };

    const listboxId = () => `${props.id}-listbox`;

    return (
        <div class="handle-input-wrapper">
            <input
                ref={inputRef}
                id={props.id}
                name={props.name}
                type="text"
                role="combobox"
                aria-expanded={showDropdown() && suggestions().length > 0}
                aria-controls={listboxId()}
                aria-activedescendant={selectedIndex() >= 0 ? `${props.id}-option-${selectedIndex()}` : undefined}
                aria-autocomplete="list"
                placeholder={props.placeholder ?? "Enter handle, DID, or profile link"}
                value={query()}
                autofocus={props.autofocus}
                autocomplete="off"
                onInput={(e) => {
                    const val = e.currentTarget.value;
                    setQuery(val);
                    doSearch(val);
                    props.onChange?.(val);
                }}
                onKeyDown={onKeyDown}
                onFocus={() => {
                    if (suggestions().length > 0) setShowDropdown(true);
                }}
                onBlur={() => {
                    // Delay to allow click/tap on suggestion
                    setTimeout(() => setShowDropdown(false), 300);
                }}
            />
            <Show when={showDropdown() && suggestions().length > 0}>
                <ul id={listboxId()} class="handle-suggestions" role="listbox">
                    <For each={suggestions()}>
                        {(actor, i) => (
                            <li
                                id={`${props.id}-option-${i()}`}
                                role="option"
                                aria-selected={i() === selectedIndex()}
                                classList={{ "suggestion-selected": i() === selectedIndex() }}
                                onMouseDown={(e) => handleSelect(e, actor)}
                                onTouchEnd={(e) => handleSelect(e, actor)}
                            >
                                <img src={actor.avatar || avatarFallback} alt="" class="suggestion-avatar" />
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
