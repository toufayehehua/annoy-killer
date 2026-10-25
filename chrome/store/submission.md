# Chrome Web Store submission

Version: 1.0.35
Default listing language: English
Category: Productivity (Tools if a subcategory is required)
Price: Free
Visibility: Public
Distribution: all countries and regions offered by the dashboard, including unlisted regions (saved)

## Single purpose
Annoy Killer lets users manually select, hide, save and restore distracting webpage elements so they can focus on the page content they choose.

## Permission justifications
- storage: Save user-selected hidden-element rules, page/site scope and element fingerprints locally and synchronize rules and change/deletion metadata through Chrome Sync across the user's Chrome devices. Rule sync is enabled by default and can be disabled in options. Interface and keyboard preferences remain local. Reapply saved rules on future visits.
- alarms: Batch pending rule synchronization and retry failed writes after the extension service worker stops or Chrome restarts. No unrelated scheduled activity.
- scripting: Initialize the selection interface on an already-open supported webpage when the user invokes the extension and it has not yet been injected.
- contextMenus: Provide direct access to options, voluntary developer support and email feedback.
- <all_urls>: Select, hide and restore elements on user-visited websites and frames, reapply saved rules, and temporarily capture visible page pixels locally for the disappearance animation. No browsing history or captures are sent to a developer server.
- Remote code: None. All executable extension code is included in the ZIP.

## Privacy declarations
The developer does not receive, sell or use browsing data for advertising. Website structure, element fingerprints (which can contain selected text), page addresses and temporary page captures are processed on the device. Hidden rules, associated addresses/scopes, element fingerprints and change/deletion metadata are synchronized by Google through Chrome Sync when available; the extension switch is enabled by default and can be turned off per device. Keyboard preferences and onboarding state remain local; captures remain in memory. The updated disclosure is in privacy.md and has been published at the existing public policy URL.

Privacy policy: https://sites.google.com/view/annoy-killer-privacy-policy/%E9%A6%96%E9%A1%B5 (existing Google Sites policy URL; the new synchronization disclosure was published and publicly verified on 2026-09-07).

## Listing assets
- English description: en.txt
- Translations: zh_CN.txt, zh_TW.txt, ja.txt, ko.txt, de.txt, fr.txt, es.txt, pt_BR.txt
- Screenshots: artwork/en/screenshot-*-1280x800.png and artwork/zh_CN/screenshot-*-1280x800.png
- Required small promotional tiles: artwork/en/small-promo-440x280.png and artwork/zh_CN/small-promo-440x280.png
- Store icon: ../icons/icon-128.png

## Current release preparation
Item ID: pcijplaemendlfdkkhacpjinpimoplce
Package: ../dist/annoy-killer-chrome-1.0.35.zip
This package includes default-on Chrome rule synchronization, the per-device switch in options, synchronization of rule removals and page-specific restoration exceptions, and removal of the shortcut reset button. It contains the current same-origin component sharing implementation already prepared in 1.0.34.

Sync logic tests (8/8), upgrade-guidance regression and focused real Chrome sync/shortcut tests passed. The broader Chrome run was 42/51; do not reuse the old 1.0.33 47/47 result for this version. Detailed caveats are in validation-1.0.35.json.

The Chrome Web Store dashboard shows draft version 1.0.35 with status 待审核. The currently published version remains 1.0.33 until Google approves the draft. Automatic publication after approval is enabled.

Submitted package: ../dist/annoy-killer-chrome-1.0.35.zip
Submitted package SHA-256: 9354e333685d76418fc7335d4a112d5cff89d25f2ae4bd239ced4da291c4738b
Submission status: pending Google review as of 2026-09-07T15:55:56Z.
