      const fs = require('fs');
      const paths = (process.env.COMPLETED_LIST||'').split(':').filter(Boolean);
      const stories = paths.flatMap(p => {
        try { return JSON.parse(fs.readFileSync(p,'utf8')).stories||[]; } catch { return []; }
      });
      fs.writeFileSync(process.argv[2], JSON.stringify({stories},null,2));
    
