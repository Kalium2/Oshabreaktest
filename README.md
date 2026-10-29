# OSHA Enforcement Search

A small website for searching **establishments, inspections, violations, and accidents**. All data comes live from the U.S. Department of Labor's OSHA enforcement datasets through the DOL Open Data Portal API (`https://apiprod.dol.gov/v4/get/OSHA/...`). The site uses no other data source.

## Features

| Tab | What it searches | OSHA dataset |
| --- | --- | --- |
| Establishments | Name, city, state, and ZIP. Results are grouped into one card per site, each listing its inspections. | `inspection` |
| Inspections | Name, activity number, location, NAICS, inspection type, and open-date range. | `inspection` |
| Violations | Activity number, standard cited, violation type, minimum penalty, and issuance-date range. | `violation` |
| Accidents | Summary number, a keyword in the description, fatal-only, and event-date range. | `accident` |

- Clicking an **activity number** opens the inspection: summary, penalty totals, every violation cited, and links to related accident investigations (through `accident_injury.rel_insp_nr`).
- Clicking a **summary number** opens the accident: the description, the full abstract (`accident_abstract`), and each injured employee (`accident_injury`), with links back to the related inspection.
- **All fields** on any row shows every field the API returned for that record.
- Code fields (inspection type, violation type, and so on) are labeled using the OSHA data dictionary.

## Getting an API key

The DOL API needs a free key. Register at <https://dataportal.dol.gov/> and create a key. Then open **API settings** on the site and paste it in. The key is stored only in your browser's `localStorage`.

## Running it

### Option 1: static hosting (GitHub Pages)
The site is plain HTML, CSS, and JavaScript with no build step. To publish it, go to **Settings → Pages**, choose "Deploy from a branch", and select `main` with the `/ (root)` folder. You can also open `index.html` directly in a browser.

### Option 2: local proxy
If your browser blocks direct cross-origin calls to `apiprod.dol.gov`, or you'd rather keep the key on a server, run the bundled proxy. It has no dependencies and needs Node 18 or newer:

```bash
DOL_API_KEY=your-key node server.js
# open http://localhost:8080 and set API settings → Connection to "Local proxy"
```

The proxy only forwards requests to `/v4/get/OSHA/{dataset}/json`.

## How queries are built

Each search becomes a DOL v4 request:

```
GET https://apiprod.dol.gov/v4/get/OSHA/inspection/json
    ?X-API-KEY=...&limit=25&offset=0&sort_by=open_date&sort=desc
    &filter_object={"and":[{"field":"estab_name","operator":"like","value":"ACME"},
                           {"field":"site_state","operator":"eq","value":"TX"}]}
```

If a search returns nothing, the site retries once, wrapping text in `%wildcards%` and sending numeric IDs as strings. This copes with how the API matches values.

## Files

- `index.html`: page layout and search forms
- `app.js`: API client, search logic, rendering
- `styles.css`: styles (light and dark)
- `server.js`: optional static server and OSHA-only API proxy

## Disclaimer

The data is from OSHA's enforcement database as published by the Department of Labor. This project is not affiliated with DOL or OSHA. Recent records may be incomplete, and open cases may change.
