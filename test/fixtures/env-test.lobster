name: env-test
env:
  TEST_VAR: "${TEST_VAR}"
steps:
  - id: test
    command: node -e "process.stdout.write(process.env.TEST_VAR || 'undefined')"
