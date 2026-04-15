/**
 * Debug endpoint — inspects sportsmemo HTML structure
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

    if (!response.ok) {
      return res.status(200).json({ error: `Fetch failed: ${response.status}` });
    }

    const html = await response.text();

    // 1. Does GRAND SALAMI appear at all?
    const gsIndex = html.search(/GRAND SALAMI/i);
    const gsFound = gsIndex !== -1;

    // 2. Does OVER RUNS appear?
    const overRunsIndex = html.search(/OVER RUNS/i);
    const overRunsFound = overRunsIndex !== -1;

    // 3. Does UNDER RUNS appear?
    const underRunsIndex = html.search(/UNDER RUNS/i);
    const underRunsFound = underRunsIndex !== -1;

    // 4. Grab 500 chars around the GS section so we can see the structure
    const gsSnippet = gsFound
      ? html.slice(gsIndex, gsIndex + 1000).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
      : 'NOT FOUND';

    // 5. Grab 500 chars around OVER RUNS row
    const overSnippet = overRunsFound
      ? html.slice(overRunsIndex - 200, overRunsIndex + 500).replace(/\s+/g, ' ')
      : 'NOT FOUND';

    // 6. Count total <tr> tags in the GS section
    let trCount = 0;
    if (gsFound) {
      const gsHtml = html.slice(gsIndex, gsIndex + 3000);
      const trMatches = gsHtml.match(/<tr/gi);
      trCount = trMatches ? trMatches.length : 0;
    }

    // 7. Try to find the OVER RUNS row and count its cells
    let cellCount = 0;
    let cellValues = [];
    if (overRunsFound) {
      // Find the full <tr> containing OVER RUNS
      const beforeOver = html.slice(0, overRunsIndex);
      const trStart = beforeOver.lastIndexOf('<tr');
      if (trStart !== -1) {
        const trEnd = html.indexOf('</tr>', overRunsIndex);
        if (trEnd !== -1) {
          const rowHtml = html.slice(trStart, trEnd + 5);
          const tdMatches = rowHtml.match(/<td[^>]*>([\s\S]*?)<\/td>/gi);
          if (tdMatches) {
            cellCount = tdMatches.length;
            cellValues = tdMatches.map(td =>
              td.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
            );
          }
        }
      }
    }

    // 8. Check if page requires JS (common issue with dynamic sites)
    const requiresJs = html.includes('You need to enable JavaScript') ||
                       html.includes('enable JavaScript') ||
                       html.length < 5000;

    return res.status(200).json({
      htmlLength: html.length,
      requiresJs,
      gsFound,
      gsIndex,
      overRunsFound,
      underRunsFound,
      gsSnippet,
      overSnippet: overRunsFound ? overSnippet : 'NOT FOUND',
      trCountInGsSection: trCount,
      overRunsCellCount: cellCount,
      overRunsCellValues: cellValues,
    });

  } catch(e) {
    return res.status(200).json({ error: e.message });
  }
};
