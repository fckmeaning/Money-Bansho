# Notice

Money Bansho is based on World Monitor (https://github.com/koala73/worldmonitor).

World Monitor: Copyright (C) 2026 Elie Habib.

This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation. It is distributed without any warranty. The full licence text is in [LICENSE](LICENSE). Existing copyright notices in the source files remain in force.

The World Monitor name and logo are not used as branding for Money Bansho. This project is not affiliated with or endorsed by the upstream project.

## Changes from World Monitor (2026-11-28)

- Removed the upstream blog, `/pro` marketing site, demos, documentation site content, SDKs, command-line client, agent plugins and skills, integrations, issue and pull-request templates, plugin manifests and the upstream project documents in the repository root.
- Removed the package scripts and Docker build steps that depended on those files.
- Replaced the upstream product name with Money Bansho in dashboard, embed, plugin, brief and email text; text about the upstream hosted service now says "upstream". Code identifiers and working service addresses are unchanged.

## Changes from World Monitor (2026-11-27)

- Renamed the user-visible product to Money Bansho; replaced the logo, favicons, app icons and page metadata. Code identifiers, protocol packages, paths, headers, environment variables and package names are unchanged.
- Added the Company Dossier page (`/dossier.html`) and its API (`/api/dossier`).
- Changed the visual theme.
- Removed upgrade banners, plan badges, purchase and pricing links, the star prompt, desktop download prompts, author social links and the new-item badges.
- Disabled the upstream analytics and real-user-monitoring collectors.
- Removed "AI" prefixes from panel titles and added a disclosure beside automated summaries.
- Variant switching now stays on the current deployment; per-subdomain dashboard pages are no longer generated.
- Simplified the deployment configuration and replaced the README; removed the translated READMEs.
- Added a directional price estimate and forecast period labels to the forecast section (2026-11-28).
