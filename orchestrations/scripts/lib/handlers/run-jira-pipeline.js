    const fs = require('fs');
    const prd = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    if (!prd.implementationOrder) prd.implementationOrder = {};
    if (!prd.implementationOrder.scaffold) {
      prd.implementationOrder = { scaffold: [], ...prd.implementationOrder };
    }
    fs.writeFileSync(process.argv[2], JSON.stringify(prd, null, 2));
  
