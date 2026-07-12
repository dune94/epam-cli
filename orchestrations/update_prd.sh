#!/bin/bash

# Read the PRD file and update pending stories with missing fields
jq '
  .stories |= map(
    if .status == "pending" then
      . + {
        reasoningEffort: (
          if .effort == "low" then "low"
          elif .effort == "high" then "high"
          else "medium"
          end
        )
      }
    else .
    end
  )
' /home/bradleyjerome/projects/ai/epam-cli/orchestrations/travel-app-prd.json > /tmp/travel-app-prd.json && mv /tmp/travel-app-prd.json /home/bradleyjerome/projects/ai/epam-cli/orchestrations/travel-app-prd.json