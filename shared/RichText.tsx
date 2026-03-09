import { tokenize } from "@atcute/bluesky-richtext-parser";
import { type Component, For, type JSX } from "solid-js";
import { profilePrefix } from "./bsky";

// Ported from the official Bluesky app's RichText.tsx for bare URL detection
const URL_RE = /(^|\s|\()((https?:\/\/[\S]+)|((?<domain>[a-z][a-z0-9]*(\.[a-z0-9]+)+)[\S]*))/gi;

function renderTextWithLinks(text: string): JSX.Element {
    const parts: JSX.Element[] = [];
    let lastIndex = 0;
    for (const match of text.matchAll(URL_RE)) {
        const fullMatch = match[2];
        const idx = match.index! + match[1].length;
        if (idx > lastIndex) {
            parts.push(text.slice(lastIndex, idx));
        }
        const href = fullMatch.startsWith("http") ? fullMatch : `https://${fullMatch}`;
        parts.push(<a href={href}>{fullMatch}</a>);
        lastIndex = idx + fullMatch.length;
    }
    if (lastIndex < text.length) {
        parts.push(text.slice(lastIndex));
    }
    return <>{parts}</>;
}

export const RichText: Component<{ text: string }> = (props) => {
    const tokens = () => tokenize(props.text);
    return (
        <>
            <For each={tokens()}>
                {(token) => {
                    switch (token.type) {
                        case "mention":
                            return <a href={`${profilePrefix}${token.handle}`}>@{token.handle}</a>;
                        case "autolink":
                            return <a href={token.url}>{token.raw}</a>;
                        default:
                            return renderTextWithLinks("content" in token ? token.content : token.raw);
                    }
                }}
            </For>
        </>
    );
};
