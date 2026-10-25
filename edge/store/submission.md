# Microsoft Edge Add-ons submission

Version: 1.1.2
Default listing language: English
Category: Productivity
Price: Free
Visibility: Public

## Single purpose

Annoy Killer lets users manually select, hide, save and restore distracting webpage elements so they can focus on the page content they choose.

## Permission justifications

- storage: Save user-selected hidden-element rules, page/site scope and element fingerprints locally and synchronize rules and change/deletion metadata through Microsoft Edge Sync across the user's Edge devices. Rule sync is enabled by default and can be disabled in options. Interface and keyboard preferences remain local. Reapply saved rules on future visits.
- alarms: Batch pending rule synchronization and retry failed writes after the extension service worker stops or Edge restarts. No unrelated scheduled activity.
- scripting: Initialize the selection interface on an already-open supported webpage when the user invokes the extension and it has not yet been injected.
- contextMenus: Provide direct access to options, voluntary developer support and email feedback.
- <all_urls>: Select, hide and restore elements on user-visited websites and frames, reapply saved rules, and temporarily capture visible page pixels locally for the disappearance animation. No browsing history or captures are sent to a developer server.
- Remote code: None. All executable extension code is included in the ZIP.

## Privacy declarations

The developer does not receive, sell or use browsing data for advertising. Website structure, element fingerprints (which can contain selected text), page addresses and temporary page captures are processed on the device. Hidden rules, associated addresses/scopes, element fingerprints and change/deletion metadata are synchronized through Microsoft Edge Sync when available; the extension switch is enabled by default and can be turned off per device. Keyboard preferences and onboarding state remain local; captures remain in memory.

## Listing assets

- Descriptions: en.txt, zh_CN.txt, zh_TW.txt, ja.txt, ko.txt, de.txt, fr.txt, es.txt, pt_BR.txt
- Screenshots: artwork/en/screenshot-*-1280x800.png and artwork/zh_CN/screenshot-*-1280x800.png
- Small promotional tiles: artwork/en/small-promo-440x280.png and artwork/zh_CN/small-promo-440x280.png
- Store icon: ../icons/icon-128.png

## Current release preparation

Package: ../dist/annoy-killer-edge-1.1.2.zip
The Edge package uses the same Manifest V3 implementation as the Chrome package. Microsoft Edge supports the `chrome.*` extension namespace; `chrome.storage.sync` is backed by the signed-in Edge profile's sync service. Edge-specific runtime and Store copy identifies Microsoft Edge Sync and Microsoft accounts.
