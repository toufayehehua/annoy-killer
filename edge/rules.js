(() => {
  "use strict";
  if (globalThis.AnnoyKillerRules) return;

  const STABLE_ATTRIBUTES = ["data-testid", "data-test", "data-cy", "data-qa"];
  const IDENTITY_ATTRIBUTES = [...STABLE_ATTRIBUTES, "aria-label", "title", "alt", "name", "href", "src"];
  const FINGERPRINT_ATTRIBUTES = [...IDENTITY_ATTRIBUTES, "role", "type"];
  const DISCLOSURE_MARKERS = new Set([
    "广告", "推广", "赞助", "ad", "ads", "advertisement", "sponsored", "promoted",
    "sponsored content", "promoted content", "推广内容", "赞助内容", "广告内容", "商业推广", "品牌推广",
    "赞助商", "赞助商广告",
    "publicite", "publicidad", "anuncio", "werbung", "anzeige", "pubblicita", "広告", "프로모션"
  ]);
  const DISCLOSURE_SELECTOR = "a, span, small, em, i, b, strong, p, div, button, [aria-label], [title], [alt]";

  function normalizeRule(storedRule) {
    const candidate = typeof storedRule === "string"
      ? { selector: storedRule }
      : storedRule;
    const matcher = normalizeMatcher(candidate);
    if (!matcher) return null;
    const group = normalizeGroup(candidate?.group);

    const shadowHosts = Array.isArray(candidate.shadowHosts)
      ? candidate.shadowHosts.map(normalizeMatcher).filter(Boolean)
      : [];
    if (Array.isArray(candidate.shadowHosts) && shadowHosts.length !== candidate.shadowHosts.length) {
      return null;
    }

    return {
      ...matcher,
      ...(candidate.overlay === true ? { overlay: true } : {}),
      ...(group ? { group } : {}),
      ...(shadowHosts.length ? { shadowHosts } : {})
    };
  }

  function normalizeGroup(group) {
    return typeof group === "string" && /^[a-z0-9_-]{1,80}$/i.test(group) ? group : null;
  }

  function normalizeMatcher(matcher) {
    if (typeof matcher === "string") matcher = { selector: matcher };
    if (!matcher || typeof matcher.selector !== "string" || !matcher.selector.length ||
        matcher.selector.length > 1600 || !isValidSelector(matcher.selector)) {
      return null;
    }
    const fingerprint = normalizeFingerprint(matcher.fingerprint);
    const recovery = normalizeRecovery(matcher.recovery);
    const marker = normalizeMarker(matcher.marker);
    // Older builds persisted broad `all:true` rules. They cannot identify the
    // one item the user selected, even when every candidate contains an ad
    // disclosure marker, so retaining them would keep hiding neighbouring items.
    if (matcher.all === true) return null;
    return {
      selector: matcher.selector,
      ...(matcher.unique === true ? { unique: true } : {}),
      ...(typeof matcher.component === "string" && matcher.component.length <= 1600 &&
        isValidSelector(matcher.component) ? { component: matcher.component } : {}),
      ...(typeof matcher.classSignature === "string"
        ? { classSignature: matcher.classSignature.slice(0, 800) }
        : {}),
      ...(fingerprint ? { fingerprint } : {}),
      ...(recovery ? { recovery } : {}),
      ...(marker ? { marker } : {})
    };
  }

  function normalizeMarker(marker) {
    if (!marker || typeof marker.text !== "string") return null;
    const text = normalizeMarkerText(marker.text);
    return text && text.length <= 40
      ? { text, ...(isDisclosureText(text)
        ? { family: "promotion", container: true }
        : marker.container === true ? { container: true } : {}) }
      : null;
  }

  function normalizeFingerprint(fingerprint) {
    if (!fingerprint || typeof fingerprint !== "object") {
      return undefined;
    }
    return {
      text: typeof fingerprint.text === "string" ? fingerprint.text.slice(0, 240) : "",
      heading: typeof fingerprint.heading === "string" ? fingerprint.heading.slice(0, 180) : "",
      attributes: fingerprint.attributes && typeof fingerprint.attributes === "object"
        ? Object.fromEntries(Object.entries(fingerprint.attributes).filter(([name, value]) =>
          FINGERPRINT_ATTRIBUTES.includes(name) && typeof value === "string" && value.length <= 300))
        : {},
      childSignature: typeof fingerprint.childSignature === "string"
        ? fingerprint.childSignature.slice(0, 240)
        : "",
      index: Number.isInteger(fingerprint.index) ? Math.max(0, fingerprint.index) : 0,
      ...(Number.isInteger(fingerprint.count) && fingerprint.count > 0 ? { count: fingerprint.count } : {})
    };
  }

  function normalizeRecovery(recovery) {
    if (!recovery || !/^[a-z][a-z0-9-]*(?:\[[^\]]+\])?$/.test(recovery.selector || "")) return null;
    const fingerprint = normalizeFingerprint(recovery.fingerprint);
    if (!fingerprint) return null;
    return {
      selector: recovery.selector,
      fingerprint,
      ...(typeof recovery.scope === "string" && recovery.scope.length <= 1600 &&
        isValidSelector(recovery.scope) ? { scope: recovery.scope } : {})
    };
  }

  function isValidSelector(selector, root = document) {
    try {
      root.querySelector(selector);
      return true;
    } catch {
      return false;
    }
  }

  function findMatcherElements(root, matcher) {
    if (matcher.component) {
      const components = [...root.querySelectorAll(matcher.component)];
      if (components.length === 1) return components;
    }
    const matches = findPrimaryElements(root, matcher);
    if (matches.length || !matcher.recovery) return matches;
    if (isPromotionMarkerMatcher(matcher)) {
      return findFingerprintSlotMatch(
        findMarkerContainers(root, matcher.marker),
        matcher.fingerprint || matcher.recovery.fingerprint,
        true
      );
    }
    const { selector, fingerprint, scope } = matcher.recovery;
    const scopes = scope ? [...root.querySelectorAll(scope)] : [];
    // A changed ancestor must not invalidate the whole rule. Recovery requires
    // a unique content/semantic identity, never just a sibling position.
    const candidates = [...root.querySelectorAll(selector)].filter(element =>
      !scopes.length || scopes.some(parent => parent.contains(element)));
    return findIdentityMatch(candidates, fingerprint) || [];
  }

  function findIdentityMatch(candidates, fingerprint) {
    const ranked = candidates.map(element => {
      let score = fingerprint.text && getNormalizedText(element) === fingerprint.text ? 8 : 0;
      if (fingerprint.heading && getHeadingText(element) === fingerprint.heading) score += 8;
      for (const [name, value] of Object.entries(fingerprint.attributes)) {
        if (IDENTITY_ATTRIBUTES.includes(name) && element.getAttribute(name) === value) score += 4;
      }
      return { element, score };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score);
    // undefined means no identity evidence; [] means conflicting evidence.
    if (!ranked.length) return undefined;
    return ranked[0].score > (ranked[1]?.score || 0) ? [ranked[0].element] : [];
  }

  function findPrimaryElements(root, matcher) {
    let candidates;
    try {
      candidates = [...root.querySelectorAll(matcher.selector)];
    } catch {
      return [];
    }
    if (matcher.marker) {
      candidates = candidates.filter((candidate) => containsMarker(candidate, matcher.marker));
    }
    if (matcher.unique) return candidates.length === 1 ? candidates : [];
    if (matcher.classSignature) {
      candidates = candidates.filter((candidate) => getClassSignature(candidate) === matcher.classSignature);
    }
    if (matcher.all) return candidates;
    if (!matcher.fingerprint) {
      if (matcher.recovery && candidates.length > 1) {
        return findIdentityMatch(candidates, matcher.recovery.fingerprint) || [];
      }
      return candidates.length === 1 ? candidates : [];
    }

    const allowSlotFallback = isPromotionMarkerMatcher(matcher) ||
      isSemanticSlotMatcher(matcher);
    const identified = findIdentityMatch(candidates, matcher.fingerprint);
    if (identified?.length || (identified && !allowSlotFallback)) return identified;
    if (!allowSlotFallback) {
      const exactMatches = candidates.filter((candidate) =>
        fingerprintMatches(candidate, matcher.fingerprint));
      return exactMatches.length === 1 ? exactMatches : [];
    }
    return findFingerprintSlotMatch(candidates, matcher.fingerprint, true);
  }

  function isPromotionMarkerMatcher(matcher) {
    return matcher.marker?.family === "promotion";
  }

  function isSemanticSlotMatcher(matcher) {
    const match = matcher.selector.match(
      /^([a-z][a-z0-9-]*)\[(is-[a-z0-9_-]+)(?:=[^\]]+)?\]$/i
    );
    return Boolean(match && isSemanticComponentTag(match[1]));
  }

  function findFingerprintSlotMatch(candidates, fingerprint, allowCountMismatch = false) {
    if (!fingerprint || !candidates.length) return [];
    const identified = findIdentityMatch(candidates, fingerprint);
    if (identified?.length || (identified && !allowCountMismatch)) return identified;
    if (!allowCountMismatch && candidates.length !== fingerprint.count) return [];

    const preferredIndex = Math.min(fingerprint.index, Math.max(0, candidates.length - 1));
    const exactMatches = candidates
      .map((element, index) => ({ element, index }))
      .filter(({ element }) => fingerprintMatches(element, fingerprint))
      .sort((first, second) =>
        Math.abs(first.index - preferredIndex) - Math.abs(second.index - preferredIndex));
    if (exactMatches.length) return [exactMatches[0].element];

    const ranked = candidates
      .map((element, index) => ({ element, index, score: fingerprintScore(element, fingerprint) }))
      .sort((first, second) =>
        second.score - first.score ||
        Math.abs(first.index - preferredIndex) - Math.abs(second.index - preferredIndex));
    if (ranked[0]?.score > 0) return [ranked[0].element];
    return candidates[preferredIndex] ? [candidates[preferredIndex]] : [];
  }

  function fingerprintMatches(element, fingerprint) {
    if (fingerprint.text && getNormalizedText(element) !== fingerprint.text) {
      return false;
    }
    if (fingerprint.childSignature && getChildSignature(element) !== fingerprint.childSignature) {
      return false;
    }
    if (fingerprint.heading && getHeadingText(element) !== fingerprint.heading) {
      return false;
    }
    return Object.entries(fingerprint.attributes || {}).every(
      ([name, value]) => element.getAttribute(name) === value
    );
  }

  function fingerprintScore(element, fingerprint) {
    let score = 0;
    const text = getNormalizedText(element);
    if (fingerprint.text && text) {
      if (text === fingerprint.text) {
        score += 8;
      } else if (text.includes(fingerprint.text) || fingerprint.text.includes(text)) {
        score += 3;
      }
    }
    if (fingerprint.childSignature && getChildSignature(element) === fingerprint.childSignature) {
      score += 4;
    }
    if (fingerprint.heading && getHeadingText(element) === fingerprint.heading) {
      score += 8;
    }
    for (const [name, value] of Object.entries(fingerprint.attributes || {})) {
      if (element.getAttribute(name) === value) {
        score += ["role", "type", "name", "aria-label"].includes(name) ? 4 : 2;
      }
    }
    return score;
  }

  function createExactMatcher(element, root, allowMarker = true) {
    const recovery = createRecovery(element, root);
    const component = createComponentSelector(element, root);
    const marker = allowMarker ? createDisclosureMarker(element) : null;
    if (marker) {
      const matcher = createFingerprintMatcher(element, root, marker);
      return matcher ? { ...matcher, recovery, ...(component ? { component } : {}) } : null;
    }
    if (element.localName === "iframe" && element.getAttribute("src")) {
      const iframeSelector = createStableIframeSelector(element);
      if (iframeSelector && isValidSelector(iframeSelector, root) &&
          [...root.querySelectorAll(iframeSelector)].includes(element) &&
          isUnique(iframeSelector, root)) {
        return { selector: iframeSelector, recovery, ...(component ? { component } : {}) };
      }
    }
    for (const attribute of STABLE_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (!value || value.length > 120) {
        continue;
      }
      const selector = `${element.localName}[${attribute}="${escapeAttribute(value)}"]`;
      if (isUnique(selector, root)) {
        return { selector, recovery, ...(component ? { component } : {}) };
      }
    }
    if (hasStableId(element)) {
      const selector = `#${CSS.escape(element.id)}`;
      if (isUnique(selector, root)) return { selector, recovery, ...(component ? { component } : {}) };
    }
    const matcher = createFingerprintMatcher(element, root);
    return matcher ? { ...matcher, recovery, ...(component ? { component } : {}) } : null;
  }

  // A broad custom module still needs an identity fingerprint. Shared
  // capability attributes such as `has-expansion-button` describe behavior,
  // not the one shelf the user selected.
  function createSimilarMatcher(element, root) {
    if (!(element instanceof Element)) return null;
    const tag = element.localName;
    if (!isSemanticComponentTag(tag)) return null;

    const marker = createDisclosureMarker(element);
    if (marker) return createFingerprintMatcher(element, root, marker);

    const family = [...root.querySelectorAll(tag)];
    const attributes = [...element.attributes].filter(({ name, value }) =>
      (STABLE_ATTRIBUTES.includes(name) || /^(?:is|has)-[a-z0-9_-]+$/i.test(name)) &&
      !isTransientComponentState(name) &&
      value.length <= 120 && !/\d{6,}/.test(value));
    const candidates = [];
    for (const { name, value } of attributes) {
      const selector = value
        ? `${tag}[${name}="${escapeAttribute(value)}"]`
        : `${tag}[${name}]`;
      if (!isValidSelector(selector, root)) continue;
      const matches = [...root.querySelectorAll(selector)];
      if (matches.includes(element) && matches.length < family.length) {
        candidates.push({ selector, count: matches.length, name });
      }
    }
    candidates.sort((first, second) => componentAttributeRank(first.name) -
      componentAttributeRank(second.name) || first.count - second.count ||
      second.selector.length - first.selector.length);
    if (!candidates.length) return createFingerprintMatcher(element, root);

    const selector = candidates[0].selector;
    const matches = [...root.querySelectorAll(selector)];
    const fingerprint = createFingerprint(element);
    fingerprint.index = Math.max(0, matches.indexOf(element));
    fingerprint.count = matches.length;
    return { selector, fingerprint };
  }

  function isSemanticComponentTag(tag) {
    return tag.includes("-") &&
      /(?:^|-)(?:shelf|section|module|banner|promo|carousel)(?:-|$)/i.test(tag);
  }

  function isTransientComponentState(name) {
    return /^is-(?:active|closed|collapsed|disabled|dismissed|dismissing|enabled|expanded|focused|hidden|hovered|loaded|loading|open|ready|selected|truncated|visible)(?:-|$)/i.test(name);
  }

  function componentAttributeRank(name) {
    if (STABLE_ATTRIBUTES.includes(name)) return 0;
    return name.startsWith("is-") ? 1 : 2;
  }

  // Component identity must not depend on room IDs, text, URLs or sibling order.
  // Keep the original exact matcher for content that cannot be shared safely.
  function createComponentSelector(element, root) {
    const tokens = node => {
      const selectors = STABLE_ATTRIBUTES.flatMap(name => {
        const value = node.getAttribute(name);
        return value && value.length <= 120 && !/\d{6,}/.test(value)
          ? [`${node.localName}[${name}="${escapeAttribute(value)}"]`] : [];
      });
      if (hasStableId(node)) selectors.push(`${node.localName}#${CSS.escape(node.id)}`);
      const classes = [...node.classList].filter(isStableClass).slice(0, 4);
      if (classes.length) selectors.push(node.localName + classes.map(name => `.${CSS.escape(name)}`).join(""));
      return selectors;
    };
    const ownSelectors = tokens(element);
    for (const selector of ownSelectors) {
      if (isUnique(selector, root)) return selector;
    }
    // Anonymous wrappers may be identified under a distinctive component, but
    // never turn a plain tag or positional path into a website-wide rule.
    let path = ownSelectors.at(-1) || element.localName;
    for (let parent = element.parentElement, depth = 0;
      parent && parent !== document.body && parent !== document.documentElement && depth < 3;
      parent = parent.parentElement, depth += 1) {
      for (const anchor of tokens(parent)) {
        const selector = `${anchor} > ${path}`;
        if (isUnique(anchor, root) && isUnique(selector, root)) return selector;
      }
      path = `${parent.localName} > ${path}`;
    }
    return null;
  }

  function toComponentRule(rule) {
    const group = rule.group ? { group: rule.group } : {};
    if (rule.all) return null;
    // Search result content changes with the query, while a disclosed
    // promotion keeps occupying the same semantic slot. Share that one slot
    // across same-origin result pages without broadening it to every ad.
    if (isPromotionMarkerMatcher(rule) && rule.fingerprint && rule.recovery &&
        !rule.shadowHosts?.length) {
      return {
        selector: rule.selector,
        fingerprint: rule.fingerprint,
        recovery: rule.recovery,
        marker: rule.marker,
        ...group,
        ...(rule.overlay ? { overlay: true } : {})
      };
    }
    const selectorFor = matcher => matcher.component || (
      matcher.recovery && !matcher.classSignature &&
      (!matcher.fingerprint || matcher.fingerprint.count === 1) &&
      /[#.\[]/.test(matcher.selector) && !/:nth-|:first-|:last-/.test(matcher.selector)
        ? matcher.selector : null);
    const selector = selectorFor(rule);
    if (!selector || rule.shadowHosts?.some(host => !selectorFor(host))) return null;
    return {
      selector,
      unique: true,
      ...group,
      ...(rule.overlay ? { overlay: true } : {}),
      ...(rule.marker ? { marker: rule.marker } : {}),
      ...(rule.shadowHosts?.length ? { shadowHosts: rule.shadowHosts.map(host => ({
        selector: selectorFor(host), unique: true
      })) } : {})
    };
  }

  function createRecovery(element, root) {
    let scope;
    for (let parent = element.parentElement; parent && parent !== document.body;
      parent = parent.parentElement) {
      const attribute = STABLE_ATTRIBUTES.find(name => parent.getAttribute(name));
      const selector = attribute
        ? `${parent.localName}[${attribute}="${escapeAttribute(parent.getAttribute(attribute))}"]`
        : hasStableId(parent) ? `#${CSS.escape(parent.id)}` : null;
      if (selector && isUnique(selector, root)) {
        scope = selector;
        break;
      }
    }
    if (element.localName === "iframe" && element.getAttribute("src")) {
      const iframeSelector = createStableIframeSelector(element);
      if (iframeSelector && isValidSelector(iframeSelector, root)) {
        return {
          selector: iframeSelector,
          fingerprint: createFingerprint(element),
          ...(scope ? { scope } : {})
        };
      }
    }
    return { selector: element.localName, fingerprint: createFingerprint(element), ...(scope ? { scope } : {}) };
  }

  function createFingerprintMatcher(element, root, marker = null) {
    const tag = element.localName;
    const stableClasses = [...element.classList]
      .filter(isStableClass)
      .slice(0, 4);
    let selector = tag + stableClasses.map((name) => `.${CSS.escape(name)}`).join("");
    let ancestor = element.parentElement;
    let depth = 0;
    while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
      if (hasStableId(ancestor)) {
        const ancestorSelector = `#${CSS.escape(ancestor.id)}`;
        if (isUnique(ancestorSelector, root)) {
          selector = `${ancestorSelector} ${selector}`;
          break;
        }
      }
      if (depth < 4) {
        const ancestorClasses = [...ancestor.classList].filter(isStableClass).slice(0, 3);
        const ancestorSelector = ancestor.localName +
          ancestorClasses.map((name) => `.${CSS.escape(name)}`).join("");
        const scopedSelector = `${ancestorSelector} > ${selector}`;
        if (isValidSelector(scopedSelector, root) &&
            root.querySelectorAll(scopedSelector).length <= root.querySelectorAll(selector).length) {
          selector = scopedSelector;
        }
      }
      ancestor = ancestor.parentElement;
      depth += 1;
    }

    if (!isValidSelector(selector, root)) {
      return null;
    }
    const fingerprint = createFingerprint(element);
    const candidates = [...root.querySelectorAll(selector)]
      .filter((candidate) => !marker || containsMarker(candidate, marker));
    fingerprint.index = Math.max(0, candidates.indexOf(element));
    fingerprint.count = candidates.length;
    return { selector, fingerprint, ...(marker ? { marker } : {}) };
  }

  function createDisclosureMarker(element) {
    const candidates = [element, ...element.querySelectorAll(DISCLOSURE_SELECTOR)];
    for (const candidate of candidates) {
      const text = getDisclosureText(candidate);
      if (text) return { text, family: "promotion", container: true };
    }
    return null;
  }

  function containsMarker(element, marker) {
    const candidates = [element, ...element.querySelectorAll(DISCLOSURE_SELECTOR)];
    return candidates.some((candidate) => marker.family === "promotion"
      ? Boolean(getDisclosureText(candidate))
      : normalizeMarkerText(candidate.textContent || "") === marker.text);
  }

  function findMarkerContainers(root, marker) {
    const markers = [...root.querySelectorAll(DISCLOSURE_SELECTOR)]
      .filter((candidate) => marker.family === "promotion"
        ? Boolean(getDisclosureText(candidate))
        : normalizeMarkerText(candidate.textContent || "") === marker.text);
    return [...new Set(markers.map(findMarkerContainer).filter(Boolean))];
  }

  function findMarkerContainer(marker) {
    let nearestHeadingContainer = null;
    for (let element = marker.parentElement, depth = 0;
      element && element !== document.body && element !== document.documentElement && depth < 12;
      element = element.parentElement, depth += 1) {
      const headingCount = element.querySelectorAll("h1, h2, h3, h4, h5, h6, [role='heading']").length;
      const hasLink = Boolean(element.querySelector("a[href]"));
      const hasMedia = Boolean(element.querySelector("img, picture, video, iframe, canvas, svg"));
      if (headingCount === 1 && hasLink) nearestHeadingContainer ||= element;
      if (isSemanticMarkerContainer(element) &&
          ((headingCount === 1 && hasLink) || (headingCount === 0 && hasLink && hasMedia))) {
        return element;
      }
    }
    return nearestHeadingContainer;
  }

  function normalizeMarkerText(value) {
    return String(value).replace(/\s+/g, " ").trim().toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/^[•·|:：\-–—]+|[•·|:：\-–—]+$/g, "").trim();
  }

  function getDisclosureText(element) {
    const values = [element.textContent, element.getAttribute?.("aria-label"),
      element.getAttribute?.("title"), element.getAttribute?.("alt")];
    return values.flatMap(disclosureTextCandidates).find(isDisclosureText) || "";
  }

  function disclosureTextCandidates(value) {
    const text = normalizeMarkerText(value);
    if (!text) return [];
    const candidates = [text];
    for (const segment of text.split(/[•·|:：\-–—]+/)) {
      const normalized = normalizeMarkerText(segment);
      if (normalized) candidates.push(normalized);
    }
    for (const prefix of [
      "广告", "推广", "赞助", "赞助商", "赞助商广告",
      "ad", "ads", "advertisement", "sponsor", "sponsored", "promoted"
    ]) {
      if (text === prefix || text.startsWith(`${prefix} `)) candidates.push(prefix);
    }
    const words = text.split(/\s+/).filter(Boolean);
    for (let length = 1; length <= Math.min(3, words.length); length += 1) {
      candidates.push(words.slice(0, length).join(" "));
    }
    return [...new Set(candidates)];
  }

  function isDisclosureText(text) {
    if (!text || text.length > 40) return false;
    if (DISCLOSURE_MARKERS.has(text)) return true;
    return /^(?:广告|推广|赞助|赞助商)(?:\s*广告|内容|信息|链接|结果)?$/.test(text) ||
      /^(?:ad|ads|advertisement|sponsor|sponsored|promoted)(?:\s+(?:ad|content|post|listing|result|link|by(?:\s+.{1,24})?))?$/.test(text);
  }

  function isSemanticMarkerContainer(element) {
    const semanticName = `${element.localName} ${element.id || ""} ${element.className || ""}`;
    if (element.matches("article, section, li, [role='listitem'], [class*='result' i], " +
        "[class*='card' i], [class*='module' i], [class*='item' i], [class*='banner' i], " +
        "[class*='promo' i], [class*='sponsor' i], [class*='advert' i], [data-ad], [data-sponsored]")) {
      return true;
    }
    if (/(?:^|[-_\s])(?:card|item|module|tile|result|entry|cell|slot|banner|promo|promotion|sponsor|sponsored|advert|ad)(?:[-_\s]|$)/i.test(semanticName)) {
      return true;
    }
    return [...element.classList].some((name) =>
      /^(?:ad|ads|advert|advertisement|promo|promotion|sponsor|sponsored)(?:[-_]|$)/i.test(name));
  }

  function createFingerprint(element) {
    const attributes = {};
    for (const name of FINGERPRINT_ATTRIBUTES) {
      const value = element.getAttribute(name);
      if (value && value.length <= 300) {
        attributes[name] = value;
      }
    }
    return {
      text: getNormalizedText(element),
      heading: getHeadingText(element),
      attributes,
      childSignature: getChildSignature(element),
      index: 0
    };
  }

  function getNormalizedText(element) {
    // innerText changes when display:none is applied and can make a recovered
    // target alternate between matching and not matching on every observation.
    return (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 240);
  }

  function getChildSignature(element) {
    return [...element.children].slice(0, 12).map((child) => child.localName).join(",");
  }

  function getHeadingText(element) {
    const heading = element.matches("h1, h2, h3, h4, h5, h6, [role='heading']")
      ? element
      : element.querySelector("h1, h2, h3, h4, h5, h6, [role='heading']");
    return heading ? getNormalizedText(heading).slice(0, 180) : "";
  }

  function getClassSignature(element) {
    return [...element.classList].sort().join(" ");
  }

  function hasStableId(element) {
    const id = element.id;
    return Boolean(id) && id.length <= 80 &&
      !/^\d/.test(id) &&
      !/[a-f\d]{10,}/i.test(id) &&
      !/\d{6,}/.test(id);
  }

  function isStableClass(name) {
    return name.length > 0 && name.length <= 56 &&
      !/^\d/.test(name) &&
      !/[a-f\d]{10,}/i.test(name) &&
      !/\d{6,}/.test(name) &&
      !/^(active|current|selected|focus|focused|hover|open|closed|show|hide|hidden)$/i.test(name);
  }

  function isUnique(selector, root = document) {
    try {
      return root.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  }

  function escapeAttribute(value) {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\n\r\f]/g, "\\A ");
  }

  function stableIframeSrcSubstring(src) {
    try {
      const url = new URL(src, location.href);
      const segments = url.pathname.split("/").filter(Boolean).slice(0, 1);
      const path = segments.length ? `/${segments[0]}` : "";
      const candidate = `${url.origin}${path}`;
      return candidate.length <= 80 ? candidate : "";
    } catch {
      return "";
    }
  }

  function createStableIframeSelector(element) {
    const src = element.getAttribute("src");
    if (!src) return null;
    const stable = stableIframeSrcSubstring(src);
    if (!stable) return null;
    return `iframe[src*="${escapeAttribute(stable)}"]`;
  }

  globalThis.AnnoyKillerRules = Object.freeze({
    normalizeRule, createExactMatcher, createSimilarMatcher, findMatcherElements, toComponentRule
  });
})();
