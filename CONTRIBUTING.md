# Contributing to Rove Code

## Developer Setup

See the [development runbook](docs/operations/development.md#first-checkout) for the initial checkout,
development commands, tests, and platform-specific desktop packaging prerequisites.

Rove Code is an independent fork with its own roadmap. Its contribution process is still taking shape.

## Before starting

Open an issue before beginning a non-trivial change. This lets us agree on the problem and scope before either side invests substantial time.

Changes are most likely to be accepted when they are:

- small and focused;
- clear about the problem they solve;
- considerate of web, desktop, mobile, and remote use;
- careful not to regress performance; and
- accompanied by focused tests when behavior changes.

Do not combine unrelated fixes or broad rewrites in one pull request. Include before-and-after images for visible interface changes and a short video when motion or timing matters.

## Working with upstream

Before implementing a fix, check whether it already exists in [the upstream project](https://github.com/pingdotgg/t3code). Changes that are broadly useful to both projects may be proposed upstream and incorporated here.

Preserve upstream copyright and attribution when carrying or adapting upstream work.
