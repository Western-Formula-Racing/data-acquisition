#!/bin/bash
set -e

echo "========================================="
echo "Universal Telemetry CI/CD Test Suite"
echo "========================================="

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Cleanup function
cleanup() {
    echo -e "\n${YELLOW}Cleaning up test environment...${NC}"
    docker compose -f docker-compose.test.yml down -v 2>/dev/null || true
    docker network prune -f 2>/dev/null || true
}

# Set trap to cleanup on exit
trap cleanup EXIT

# Step 1: Build Docker image
echo -e "\n${YELLOW}Step 1: Building Docker image...${NC}"
docker build -t universal-telemetry:test . || {
    echo -e "${RED}✗ Docker build failed${NC}"
    exit 1
}
echo -e "${GREEN}✓ Docker image built successfully${NC}"

# Step 2: Start test environment
echo -e "\n${YELLOW}Step 2: Starting test environment...${NC}"
docker compose -f docker-compose.test.yml up -d --build || {
    echo -e "${RED}✗ Failed to start containers${NC}"
    exit 1
}
echo -e "${GREEN}✓ Containers started${NC}"

# Step 3: Wait for services to be ready
echo -e "\n${YELLOW}Step 3: Waiting for services to be ready...${NC}"
sleep 15

# Check container status
echo "Container status:"
docker compose -f docker-compose.test.yml ps

# Step 4: Verify containers are running
echo -e "\n${YELLOW}Step 4: Verifying containers...${NC}"
for container in daq-car daq-base daq-car-redis daq-base-redis daq-pecan-test; do
    if docker ps --format '{{.Names}}' | grep -q "^${container}$"; then
        echo -e "${GREEN}✓ ${container} is running${NC}"
    else
        echo -e "${RED}✗ ${container} is not running${NC}"
        echo "Logs for ${container}:"
        docker logs ${container} 2>&1 || true
        exit 1
    fi
done

# Step 5: Show initial logs
echo -e "\n${YELLOW}Step 5: Initial container logs...${NC}"
echo "--- Car Container ---"
docker logs daq-car --tail 20 2>&1 || true
echo -e "\n--- Base Container ---"
docker logs daq-base --tail 20 2>&1 || true

# Step 6: Run integration tests
echo -e "\n${YELLOW}Step 6: Running integration tests...${NC}"
python3 -m pytest tests/test_integration.py -v -s || {
    TEST_EXIT_CODE=$?
    echo -e "\n${RED}✗ Integration tests failed${NC}"

    # Collect logs for debugging
    echo -e "\n${YELLOW}Collecting logs for debugging...${NC}"
    mkdir -p test-logs
    docker compose -f docker-compose.test.yml logs --no-color > test-logs/docker-compose.log 2>&1
    docker logs daq-car > test-logs/car.log 2>&1 || true
    docker logs daq-base > test-logs/base.log 2>&1 || true
    docker logs daq-car-redis > test-logs/car-redis.log 2>&1 || true
    docker logs daq-base-redis > test-logs/base-redis.log 2>&1 || true
    docker logs daq-pecan-test > test-logs/pecan.log 2>&1 || true

    echo -e "${YELLOW}Logs saved to test-logs/ directory${NC}"
    exit $TEST_EXIT_CODE
}

# Step 7: Run WebSocket v2 protocol tests
echo -e "\n${YELLOW}Step 7: Running WebSocket v2 protocol tests...${NC}"
python3 -m pytest tests/test_websocket_v2.py -v -s || {
    TEST_EXIT_CODE=$?
    echo -e "\n${RED}✗ WebSocket v2 tests failed${NC}"

    # Collect logs for debugging
    echo -e "\n${YELLOW}Collecting logs for debugging...${NC}"
    mkdir -p test-logs
    docker compose -f docker-compose.test.yml logs --no-color > test-logs/docker-compose.log 2>&1
    docker logs daq-car > test-logs/car.log 2>&1 || true
    docker logs daq-base > test-logs/base.log 2>&1 || true

    echo -e "${YELLOW}Logs saved to test-logs/ directory${NC}"
    exit $TEST_EXIT_CODE
}

echo -e "\n${GREEN}=========================================${NC}"
echo -e "${GREEN}✓ All tests passed successfully!${NC}"
echo -e "${GREEN}=========================================${NC}"

exit 0
