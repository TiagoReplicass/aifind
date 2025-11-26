#!/bin/bash

echo "========================================"
echo "   TiagoX Finder - Avvio Automatico"
echo "========================================"
echo

echo "[1/3] Installazione dipendenze frontend..."
npm install
if [ $? -ne 0 ]; then
    echo "ERRORE: Installazione frontend fallita!"
    exit 1
fi

echo
echo "[2/3] Installazione dipendenze backend..."
cd server
npm install
if [ $? -ne 0 ]; then
    echo "ERRORE: Installazione backend fallita!"
    exit 1
fi

echo
echo "[3/3] Avvio servizi..."
echo

echo "Avviando backend server su http://localhost:3000..."
npm run dev &
BACKEND_PID=$!

sleep 3

cd ..
echo "Avviando frontend su http://localhost:5173..."
npm run dev &
FRONTEND_PID=$!

echo
echo "========================================"
echo "   Servizi avviati con successo!"
echo "========================================"
echo "   Frontend: http://localhost:5173/"
echo "   Backend:  http://localhost:3000/"
echo "========================================"
echo
echo "Premi Ctrl+C per fermare tutti i servizi"

# Funzione per terminare i processi quando lo script viene interrotto
cleanup() {
    echo
    echo "Fermando i servizi..."
    kill $BACKEND_PID 2>/dev/null
    kill $FRONTEND_PID 2>/dev/null
    echo "Servizi fermati."
    exit 0
}

# Cattura il segnale di interruzione
trap cleanup INT

# Aspetta che i processi finiscano
wait