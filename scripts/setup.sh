#!/usr/bin/env bash
set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo -e "${CYAN}  ◈  Aria Voice Scheduler — Setup${NC}"
echo "  ─────────────────────────────────"
echo ""

# ── Check dependencies ─────────────────────────────────────────────────────────
echo -e "${YELLOW}Checking dependencies...${NC}"

if ! command -v node &>/dev/null; then
  echo -e "${RED}✗ Node.js not found. Install from https://nodejs.org${NC}"; exit 1
fi

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  echo -e "${RED}✗ Node.js 18+ required (found v$(node -v))${NC}"; exit 1
fi

echo -e "${GREEN}✓ Node.js $(node -v)${NC}"
echo -e "${GREEN}✓ npm $(npm -v)${NC}"

# ── Backend env setup ──────────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}Setting up backend...${NC}"

cd "$(dirname "$0")/../backend"

if [ ! -f .env ]; then
  cp .env.example .env
  echo -e "${GREEN}✓ Created backend/.env from template${NC}"
  echo -e "${YELLOW}  ⚠  Please fill in your API keys in backend/.env${NC}"
else
  echo -e "${GREEN}✓ backend/.env already exists${NC}"
fi

npm install --silent
echo -e "${GREEN}✓ Backend dependencies installed${NC}"

# ── Frontend env setup ─────────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}Setting up frontend...${NC}"

cd ../frontend

if [ ! -f .env ]; then
  echo "REACT_APP_API_URL=http://localhost:3001" > .env
  echo -e "${GREEN}✓ Created frontend/.env${NC}"
else
  echo -e "${GREEN}✓ frontend/.env already exists${NC}"
fi

npm install --silent
echo -e "${GREEN}✓ Frontend dependencies installed${NC}"

# ── Done ───────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}  ✓ Setup complete!${NC}"
echo ""
echo "  Next steps:"
echo -e "  1. Edit ${CYAN}backend/.env${NC} and fill in your API keys"
echo -e "  2. Run ${CYAN}npm run dev${NC} in the backend/ folder"
echo -e "  3. Run ${CYAN}npm start${NC} in the frontend/ folder"
echo -e "  4. Open ${CYAN}http://localhost:3000${NC}"
echo ""
echo "  Or use Docker:  docker-compose up --build"
echo ""
