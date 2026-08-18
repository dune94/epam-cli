      const p = JSON.parse(require('fs').readFileSync(process.argv[2],'utf8'));
      console.log((p.project && p.project.outputDirs ? p.project.outputDirs : []).length);
    
