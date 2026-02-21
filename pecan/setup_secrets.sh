#!/bin/bash

# Check if gh CLI is installed
if ! command -v gh &> /dev/null; then
    echo "GitHub CLI (gh) is not installed or not in PATH."
    echo "If you are using WSL/Linux, install it with:"
    echo "  (type -p wget >/dev/null || (sudo apt update && sudo apt-get install wget -y)) \\"
    echo "  && sudo mkdir -p -m 755 /etc/apt/keyrings \\"
    echo "  && wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \\"
    echo "  && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \\"
    echo "  && echo \"deb [arch=\$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \\"
    echo "  && sudo apt update \\"
    echo "  && sudo apt install gh -y"
    exit 1
fi

# Check authentication
if ! gh auth status &> /dev/null; then
    echo "You are not logged in to GitHub CLI."
    echo "Please run 'gh auth login' first."
    exit 1
fi

ENV_FILE=".env"
if [ ! -f "$ENV_FILE" ]; then
    echo ".env file not found!"
    exit 1
fi

echo "Reading secrets from $ENV_FILE..."

# Read .env file line by line
while IFS='=' read -r key value || [ -n "$key" ]; do
    # Skip comments and empty lines
    [[ $key =~ ^#.* ]] && continue
    [[ -z $key ]] && continue
    
    # Trim whitespace (if any)
    key=$(echo "$key" | xargs)
    value=$(echo "$value" | xargs)

    if [ -n "$key" ] && [ -n "$value" ]; then
        echo "Setting secret: $key"
        echo "$value" | gh secret set "$key"
    fi
done < "$ENV_FILE"

echo "All secrets imported successfully!"
