/**
 * Debug endpoint v2 — shows raw GS row HTML so we can see exact structure
 * Visit: /api/debug-sportsmemo
 * DELETE THIS FILE after debugging
 */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  try {
    const response = await fetch('https://www.sportsmemo.com/odds', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      }
    });

    const html = await response.text();

    // Find GS section
    const gsIndex = html.search(/GRAND SALAMI/i);
    if (gsIndex === -1) {
      return res.status(200).json({ error: 'GRAND SALAMI not found' });
    }

    const gsHtml = html.slice(gsIndex, gsIndex + 5000);

    // Find the row with OVER RUNS
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let gsRow = null;
    let match;
    while ((match = rowRegex.exec(gsHtml)) !== null) {
      if (match[0].includes('OVER RUNS')) {
        gsRow = match[0];
        break;
      }
    }

    if (!gsRow) {
      // Return raw GS section so we can see what's there
      return res.status(200).json({
        error: 'OVER RUNS row not found in GS section',
        rawGsSection: gsHtml.slice(0, 2000),
      });
    }

    // Return the raw row HTML + all td/th content
    const tdMatches = [...gsRow.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)];
    const cells = tdMatches.map((m, i) => ({
      index: i,
      tag: m[0].slice(0, 50), // opening tag
      rawHtml: m[1].slice(0, 200), // inner HTML
      textContent: m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    }));

    return res.status(200).json({
      rowFound: true,
      rowLength: gsRow.length,
      cellCount: cells.length,
      rawRowStart: gsRow.slice(0, 500), // first 500 chars of row
      cells,
    });

  } catch(e) {
    return res.status(200).json({ error: e.message });
  }
};
