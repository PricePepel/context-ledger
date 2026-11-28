"""T1a: a hub for the latent mappers (design in docs/mapper-hub.md). A CPU prototype.

plan.py     how many parts a library needs and how large they are (standard library)
library.py  the shipped library: manifest, build keys, checksums, route choice, refusals
            (standard library)
hub.py      a direct mapper split into a per-model encoder and decoder, and two direct
            mappers chained through a pivot model's cache (torch)

Nothing here is trained and nothing here is served yet.
"""
