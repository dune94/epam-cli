    const p = require('./_read-input.js').readJsonOrRefuse(process.argv[2], "the run's codeline scope");
    const dirs = p.project && p.project.outputDirs ? p.project.outputDirs : [];
    if (dirs.length > 0) {
      dirs.forEach(d => console.log(d.codeline + ':' + d.path));
    } else {
      const cl  = process.env.JIRA_DEFAULT_CODELINE || '';
      const dir = p.project && p.project.outputDir ? p.project.outputDir : '';
      if (cl && dir) console.log(cl + ':' + dir);
    }
  
