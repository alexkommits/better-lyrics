import { t } from "@core/i18n";

const LINK_MARKER = "\u2063";

interface Link {
  href: string;
  text: string;
  avatar?: string;
  avatarRound?: boolean;
}

export function linkPlaceholders(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${LINK_MARKER}${i}${LINK_MARKER}`);
}

export function splitLinked(message: string): (string | number)[] {
  return message.split(LINK_MARKER).map((part, i) => (i % 2 === 0 ? part : Number(part)));
}

function createLink({ href, text, avatar, avatarRound }: Link): HTMLAnchorElement {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  if (avatar) {
    const img = document.createElement("img");
    img.className = avatarRound ? "about__avatar about__avatar--round" : "about__avatar";
    img.src = avatar;
    img.alt = "";
    anchor.append(img);
  }
  anchor.append(text);
  return anchor;
}

function fillLinked(el: HTMLElement, key: string, links: Link[]): void {
  el.replaceChildren(
    ...splitLinked(t(key, linkPlaceholders(links.length))).map(part =>
      typeof part === "string" ? document.createTextNode(part) : createLink(links[part])
    )
  );
}

function fillExternalLink(el: HTMLElement, link: Link): void {
  const anchor = createLink(link);
  const icon = document.createElement("span");
  icon.dataset.icon = "externalLink";
  anchor.append(icon);
  el.replaceChildren(anchor);
}


// -- Support stage --------------------------

