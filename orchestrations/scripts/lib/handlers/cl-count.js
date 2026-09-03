      const p = require('./_read-input.js').readJsonOrRefuse(process.argv[2], "the run's codeline scope");
      console.log((p.project && p.project.outputDirs ? p.project.outputDirs : []).length);
    
