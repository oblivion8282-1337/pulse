/* Kann diese GPU Intra-Refresh ueber VAAPI? — Fragt den Treiber direkt.
 *
 * `vainfo` beantwortet das NICHT: es listet Profile und Entrypoints, aber
 * nicht die Encoder-Attribute. Genau eines davon entscheidet hier alles.
 *
 * Hintergrund (Pulse-Labor, 2026-07-31): Intra-Refresh ersetzt die
 * periodischen Keyframes und hat auf Linux+NVIDIA messbar gewonnen — gleiche
 * Datenrate, 97 Prozent weniger Haenger, 16 VMAF-Punkte besseres Bild. Ob der
 * AMD-Weg mitkommt, haengt an zwei Dingen:
 *
 *   1. Kann Treiber und Hardware es?      <- DIESES Programm beantwortet das
 *   2. Reicht FFmpeg es durch?            <- NEIN (av1_vaapi/h264_vaapi
 *                                            kennen keine intra-refresh-Option)
 *
 * Punkt 2 gilt unabhaengig von Punkt 1. Faellt Punkt 1 aber negativ aus, ist
 * jede Arbeit an Punkt 2 vergeblich — deshalb zuerst hier messen.
 *
 * Bauen und laufen lassen (auf der AMD-Maschine):
 *
 *     cc -o vaapi-ir vaapi-intra-refresh-pruefen.c -lva -lva-drm
 *     ./vaapi-ir
 *
 * Braucht `libva-devel` (Fedora) / `libva-dev` (Debian, Ubuntu) /
 * `libva` (Arch). Bei mehreren GPUs: ./vaapi-ir /dev/dri/renderD129
 */

#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#include <va/va.h>
#include <va/va_drm.h>

/* Die Profile, die fuer uns zaehlen: AV1 ist der Produktionscodec, H.264 der
 * Rueckfall. Mehr braucht es nicht — wer H.265 sendet, ist hier falsch. */
static const struct {
    VAProfile profil;
    const char *name;
} PROFILE[] = {
    {VAProfileAV1Profile0, "AV1 Profile0"},
    {VAProfileH264High, "H.264 High"},
    {VAProfileH264Main, "H.264 Main"},
    {VAProfileHEVCMain, "HEVC Main"},
};

static void profil_pruefen(VADisplay dpy, VAProfile profil, const char *name)
{
    /* Zwei Attribute auf einmal: Intra-Refresh ist die Frage, die Paketierung
     * (`PackedHeaders`) steht daneben, weil sie im selben Aufruf kommt und bei
     * einer negativen Antwort die naechste Frage waere. */
    VAConfigAttrib attribs[2] = {
        {.type = VAConfigAttribEncIntraRefresh},
        {.type = VAConfigAttribRateControl},
    };

    VAStatus st = vaGetConfigAttributes(dpy, profil, VAEntrypointEncSlice,
                                        attribs, 2);
    if (st != VA_STATUS_SUCCESS) {
        printf("  %-14s  kein Encoder fuer dieses Profil (%s)\n",
               name, vaErrorStr(st));
        return;
    }

    unsigned int ir = attribs[0].value;
    if (ir == VA_ATTRIB_NOT_SUPPORTED || ir == 0) {
        printf("  %-14s  Intra-Refresh: NEIN\n", name);
        return;
    }

    /* Die Bits stehen in va.h unter „Attribute values for
     * VAConfigAttribEncIntraRefresh". Welche Art der Treiber anbietet, ist
     * wichtig: fuer unseren Zweck genuegt Zeilen- oder Spalten-Refresh. */
    printf("  %-14s  Intra-Refresh: JA  (0x%x", name, ir);
    if (ir & VA_ENC_INTRA_REFRESH_ROLLING_COLUMN) printf(", rollende Spalte");
    if (ir & VA_ENC_INTRA_REFRESH_ROLLING_ROW)    printf(", rollende Zeile");
    if (ir & VA_ENC_INTRA_REFRESH_ADAPTIVE)       printf(", adaptiv");
    if (ir & VA_ENC_INTRA_REFRESH_CYCLIC)         printf(", zyklisch");
    printf(")\n");
}

int main(int argc, char **argv)
{
    const char *geraet = argc > 1 ? argv[1] : "/dev/dri/renderD128";

    int fd = open(geraet, O_RDWR);
    if (fd < 0) {
        fprintf(stderr, "%s nicht zu oeffnen. Anderes Geraet angeben, oder "
                        "fehlt die Gruppe `video`/`render`?\n", geraet);
        return 1;
    }

    VADisplay dpy = vaGetDisplayDRM(fd);
    int major = 0, minor = 0;
    VAStatus st = vaInitialize(dpy, &major, &minor);
    if (st != VA_STATUS_SUCCESS) {
        fprintf(stderr, "vaInitialize scheiterte: %s\n", vaErrorStr(st));
        close(fd);
        return 1;
    }

    printf("Geraet   %s\n", geraet);
    printf("Treiber  %s\n", vaQueryVendorString(dpy));
    printf("libva    %d.%d\n\n", major, minor);

    for (size_t i = 0; i < sizeof(PROFILE) / sizeof(PROFILE[0]); i++)
        profil_pruefen(dpy, PROFILE[i].profil, PROFILE[i].name);

    printf("\nSteht bei AV1 oder H.264 ein JA, kann die Hardware es — dann ist\n"
           "nur noch FFmpeg im Weg (av1_vaapi/h264_vaapi bieten die Option\n"
           "nicht an). Steht ueberall NEIN, ist Intra-Refresh auf diesem\n"
           "Geraet ueber VAAPI nicht erreichbar.\n");

    vaTerminate(dpy);
    close(fd);
    return 0;
}
