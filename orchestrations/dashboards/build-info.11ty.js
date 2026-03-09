const { loadSnapshot } = require('./build/snapshot');

module.exports = class BuildInfoTemplate {
  data() {
    return {
      permalink: 'build-info.json',
      eleventyExcludeFromCollections: true
    };
  }

  render() {
    return JSON.stringify(loadSnapshot(), null, 2);
  }
};
