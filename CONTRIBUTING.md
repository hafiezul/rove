# Contributing to Rove Code

## Developer Setup

See the [development runbook](docs/operations/development.md#first-checkout) for the initial checkout,
development commands, tests, and platform-specific desktop packaging prerequisites.

Rove Code is an early fork of [Rove Code](https://github.com/rovecode/rove). Its direction and contribution process are still taking shape.

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

Before implementing a fix, check whether it already exists in [upstream Rove Code](https://github.com/rovecode/rove). Changes that are broadly useful and align with upstream's direction may be better proposed there first, then incorporated into Rove Code.

Preserve upstream copyright and attribution when carrying or adapting upstream work.
