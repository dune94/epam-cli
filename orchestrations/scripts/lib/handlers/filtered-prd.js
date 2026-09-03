      const fs  = require('fs');
      const prd = require('./_read-input.js').readJsonOrRefuse(process.argv[2], 'the PRD', { expect: 'object' });
      const cl  = process.argv[4], dcl = process.env.JIRA_DEFAULT_CODELINE||'';
      // A story may SPAN codelines. codelines[] is authoritative when present:
      // the story stays whole and participates in each lane's execution, rather
      // than being partitioned into exactly one. Without this it matches no
      // partition, appears in zero filtered PRDs, and is silently dropped from
      // the run — which is how a [GO, UP, MX] ticket reached ingest and died.
      // The top-level shape is checked on read; a PRD that parsed but carries no stories array
      // still reaches here, and `.filter` on undefined is a node internal thrown mid-run.
      const stories = (prd.stories || []).filter(s =>
        (Array.isArray(s.codelines) && s.codelines.length
          ? s.codelines.includes(cl)
          : (s.codeline === cl || (!s.codeline && cl === dcl)))
      // THIS LANE'S PRD SAYS WHICH LANE IT IS.
      //
      // Stories were copied through unchanged, so a story spanning three codelines carried
      // its PRIMARY codeline into all three lane PRDs. Every consumer reading the singular
      // field then got the same answer everywhere: the detective resolved the first lane's
      // investigator in all three lanes and investigated two repositories with a brief written
      // for a different one. agentRole had the identical defect, and project.outputDir vs
      // outputDirs a third instance.
      //
      // Fixed HERE rather than in each reader. A lane's PRD describing a different lane is the
      // lie; once it tells the truth, every consumer — the detective, the guards, the manifest,
      // whatever is added next — is correct without knowing lanes exist. codelines[] is left
      // intact, so nothing loses the knowledge that the story spans more than this one.
      // THIS LANE'S CRITERIA, NOT THE UNION.
      //
      // verificationCriteria / fixSiteAnalysis on canonical are the UNION across every lane —
      // that is what canonical is for. Copying them through means a lane is handed other
      // codelines' criteria, describing files that do not exist in its checkout.
      //
      // On a first run the spec pass overwrote them before anything read them, so it never
      // showed. On a RESUME the spec pass is skipped — the whole point of resuming — so the
      // lane keeps the union, its writer and gates verify against it, and
      // mergeLaneIntoCanonical then faithfully records the union as THIS LANE'S OWN criteria.
      // Live 2026-08-09: four killed runs turned gotransit's 4 criteria into all 14, and 13 fix
      // sites into 22, compounding on every kill.
      //
      // Same rule as `codeline` above, and for the same reason: a lane's PRD states that lane's
      // truth. Falls back to the flat list when there is no entry for this codeline (a first
      // run, or a lane added later) — never to nothing, which would hand a writer an empty
      // plan. An explicitly EMPTY entry is honoured, because 'this lane found nothing to
      // verify' is a real state and differs from 'this lane has not run'.
      //
      // No double quotes anywhere in this block, comments included: the node script is passed
      // inside a double-quoted shell string, so one would end it and bash would execute the
      // JavaScript that follows.
      ).map(s => {
        const _scoped = (flat, perCl) =>
          (perCl && Object.prototype.hasOwnProperty.call(perCl, cl)) ? perCl[cl] : flat;
        return {
          ...s,
          codeline: cl,
          verificationCriteria: _scoped(s.verificationCriteria, s.verificationCriteriaPerCodeline),
          fixSiteAnalysis: _scoped(s.fixSiteAnalysis, s.fixSiteAnalysisPerCodeline),
        };
      });
      const ids = new Set(stories.map(s => s.id));
      const order = {};
      for (const [phase, list] of Object.entries(prd.implementationOrder||{})) {
        const f = (list||[]).filter(id => ids.has(id));
        if (f.length > 0) order[phase] = f;
      }
      if (Object.keys(order).length === 0) order.core = stories.map(s => s.id);
      const out = {...prd, stories, implementationOrder: order};
      if (prd.project && prd.project.outputDirs) {
        const d = prd.project.outputDirs.find(d => d.codeline === cl);
        if (d) out.project = {...prd.project, outputDir: d.path};
      }
      fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 2));
      console.log(stories.length);
    
