#!/bin/bash
# NumaVM — Parse kernel cmdline dm.* parameters into DM_* env vars
# Sourced by setup.sh and app.sh

if [ -z "${DM_ip:-}" ]; then
  for param in $(cat /proc/cmdline); do
    case "$param" in
      dm.*)
        key=$(echo "$param" | cut -d= -f1 | sed 's/^dm\./DM_/')
        val=$(echo "$param" | cut -d= -f2-)
        export "$key"="$val"
        ;;
    esac
  done
fi
