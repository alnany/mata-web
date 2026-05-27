/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert'],
    ],
    'scope-enum': [
      2,
      'always',
      ['web', 'worker', 'shared', 'ui', 'config', 'ci', 'docs', 'release', 'deps', 'root'],
    ],
    'subject-case': [2, 'always', 'sentence-case'],
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
  },
};
