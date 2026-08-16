      try {
        const p = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
        const stories = Array.isArray(p.stories) ? p.stories : [];
        const has = (v) => Array.isArray(v) ? v.length > 0
          : (v && typeof v === 'object') ? Object.keys(v).length > 0 : false;
        const survived = stories.some((s) => s && (
          has(s.fixSiteAnalysis) || has(s.verificationCriteria) ||
          has(s.specification) || has((s.technicalNotes || {}).files)));
        process.exit(survived ? 0 : 1);
      } catch { process.exit(1); }
    
