// THE PRD IS argv[2]. This read argv[1] — the script's own path — so it parsed its own
// JavaScript as JSON, threw, and answered "no spec output" for every PRD ever passed to it.
// The guard could never pass, so every resume that skips the spec pass was refused. Same
// extraction defect as lib/handlers/prd-phases.js, which carried a literal '$1' from the
// shell heredoc it was lifted out of and made every lane loop zero times.
      try {
        const p = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
        const stories = Array.isArray(p.stories) ? p.stories : [];
        const has = (v) => Array.isArray(v) ? v.length > 0
          : (v && typeof v === 'object') ? Object.keys(v).length > 0 : false;
        const survived = stories.some((s) => s && (
          has(s.fixSiteAnalysis) || has(s.verificationCriteria) ||
          has(s.specification) || has((s.technicalNotes || {}).files)));
        process.exit(survived ? 0 : 1);
      } catch { process.exit(1); }
    
