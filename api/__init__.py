"""HTTP API over the domain layer in src/.

This package exposes the domain layer over HTTP so the frontend -- the
TypeScript canvas and 3D view in frontend/ -- can own the arrangement
state and ask Python for the numbers: pack a layout, check access, score
stacking, run a chat turn. Nothing architectural lives here; every
endpoint is a thin wrapper over a function in src/.
"""
