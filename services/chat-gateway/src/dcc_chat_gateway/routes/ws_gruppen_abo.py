"""Das Abonnement eines privaten Gruppenkanals (Etappe G).

Eigene Datei aus demselben Grund wie ``ws_op_send.py``: mit dieser Pruefung
im Rumpf waere ``ws_ops_handlers.py`` ueber die harte Groessen-Grenze
(PLAN.md §12.1) gewachsen.
"""

from __future__ import annotations

from dcc_chat_gateway.private_gruppen_zugriff import gruppen_teilnehmer
from dcc_chat_gateway.routes.ws_ops_registry import WSOpContext


async def gruppen_abo_versuchen(ctx: WSOpContext, session, kanal_id: int) -> bool:
    """Abonniert ``kanal_id``, wenn es eine private Gruppe dieses Nutzers ist.

    ``False`` heisst „keine erreichbare Gruppe" — der Aufrufer antwortet dann
    mit seinem eigenen Fehler, ohne die drei Gruende zu unterscheiden.

    Aufgerufen erst, wenn ``resolve_channel_for_user`` nichts gefunden hat:
    der Resolver kennt eine private Gruppe bewusst nicht — eine dritte
    Kanalart dort waere ein Durchgang durch fuenfzehn Dateien, die zwischen
    „DM" und „Community" unterscheiden (Begruendung im Modulkopf von
    ``private_gruppen_zugriff.py``). Nur DIESE Stelle fragt zusaetzlich nach,
    weil ohne Abonnement der ``postfach_neu``-Weckruf den Klienten nie
    erreicht: er faechert an ``_subs[<kanal_id>]`` auf.

    ``gruppen_teilnehmer`` prueft Schalter, Existenz und Mitgliedschaft in
    einem und unterscheidet die drei Faelle bewusst nicht — die Antwort ist
    ohnehin dieselbe.

    **``ctx.subscribed`` bleibt unberuehrt.** Dieser Satz ist die Erlaubnis
    fuer den Klartext-``send``-Schnellweg, und den gibt es fuer Gruppen nicht
    (sie sind von Geburt an verschluesselt, Spec §9). Eine Gruppen-ID faellt
    damit im Sendeweg unveraendert durch.
    """
    if await gruppen_teilnehmer(session, kanal_id, ctx.user.id) is None:
        return False
    await ctx.manager.subscribe(ctx.websocket, str(kanal_id))
    return True
