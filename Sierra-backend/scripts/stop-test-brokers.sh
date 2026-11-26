#!/usr/bin/env bash
RABBITMQ_NODENAME=sierra_t@localhost rabbitmqctl stop >/dev/null 2>&1 || true
