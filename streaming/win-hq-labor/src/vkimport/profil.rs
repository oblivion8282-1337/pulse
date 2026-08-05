//! Das Video-Profil für die Bild-Erzeugung — **der Rückfall**, nicht der
//! Regelweg.
//!
//! Ein Bild mit `VIDEO_ENCODE_SRC_BIT` braucht laut Spezifikation eine
//! Profil-Liste im `pNext` — es sei denn, es trägt
//! `VK_IMAGE_CREATE_VIDEO_PROFILE_INDEPENDENT_BIT_KHR`. Für ein importiertes
//! Bild ist das Bit das Richtige, und es ist auch das, was den 10-Bit-Fehler
//! behebt; die Herleitung steht an [`super::VulkanImport::new`]. Nur wenn
//! `VK_KHR_video_maintenance1` fehlt, gibt es das Bit nicht — dann ist diese
//! Liste Pflicht, und [`super::VulkanImport::importiere`] hängt sie an.
//!
//! **Die Liste behebt das Magenta nicht.** Am 2026-08-02 nachgemessen: mit
//! Profil-Liste sah das 10-Bit-Bild aus wie ohne. Sie ist ein echter
//! Spezifikations-Mangel gewesen und ist trotzdem behoben worden — richtig sein
//! und die Ursache sein sind zwei Dinge.
//!
//! FFmpeg baut dieselbe Kette: `vulkan_encode.c` legt sie an und hängt sie als
//! `hwctx->create_pnext` an den **DPB**-Frames-Kontext, wo
//! `hwcontext_vulkan.c` sie in jede `VkImageCreateInfo` einkettet. Für den
//! Eingangs-Kontext tut es das nicht — dort steht stattdessen das Bit.
//!
//! **Die Struktur muss am Stück leben.** Die drei Vulkan-Strukturen verweisen
//! mit rohen Zeigern aufeinander; ein Aufbau in einer Funktion, die dann
//! zurückkehrt, hinterließe baumelnde Zeiger. Deshalb liegen sie zusammen in
//! einem Feld des Importers und werden dort erst beim `vkCreateImage` gelesen.

use std::ffi::c_void;

use super::vk::*;

/// Für welchen Encoder die Bilder gedacht sind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Videocodec {
    Av1,
    H264,
}

/// Profil-Kette für `VkImageCreateInfo::pNext`.
///
/// Selbstbezüglich (`liste` zeigt auf `profil`, `profil` auf `codec`, dieser
/// auf `nutzung`) — deshalb `Box`, damit die Adressen beim Verschieben der
/// Struktur stabil bleiben, und deshalb wird die Kette erst in [`Self::kette`]
/// verknüpft statt beim Anlegen.
pub(super) struct Videoprofil {
    liste: Box<VkVideoProfileListInfoKHR>,
    profil: Box<VkVideoProfileInfoKHR>,
    codec: Box<VkVideoEncodeCodecProfileInfo>,
    nutzung: Box<VkVideoEncodeUsageInfoKHR>,
}

impl Videoprofil {
    pub(super) fn neu(codec: Videocodec, zehn_bit: bool) -> Self {
        let tiefe = if zehn_bit {
            VK_VIDEO_COMPONENT_BIT_DEPTH_10_BIT_KHR
        } else {
            VK_VIDEO_COMPONENT_BIT_DEPTH_8_BIT_KHR
        };
        let (op, s_type, std_profil) = match codec {
            Videocodec::Av1 => (
                VK_VIDEO_CODEC_OPERATION_ENCODE_AV1_BIT_KHR,
                VK_STRUCTURE_TYPE_VIDEO_ENCODE_AV1_PROFILE_INFO_KHR,
                STD_VIDEO_AV1_PROFILE_MAIN,
            ),
            Videocodec::H264 => (
                VK_VIDEO_CODEC_OPERATION_ENCODE_H264_BIT_KHR,
                VK_STRUCTURE_TYPE_VIDEO_ENCODE_H264_PROFILE_INFO_KHR,
                STD_VIDEO_H264_PROFILE_IDC_HIGH,
            ),
        };
        Self {
            // Alle Zeiger zunächst leer; `kette` setzt sie, wenn die Adressen
            // feststehen.
            nutzung: Box::new(VkVideoEncodeUsageInfoKHR {
                s_type: VK_STRUCTURE_TYPE_VIDEO_ENCODE_USAGE_INFO_KHR,
                p_next: std::ptr::null(),
                // 0 = „keine Angabe". Die Hinweise sind Empfehlungen an den
                // Treiber; hier zählt nur, dass Profil und Bittiefe stimmen.
                video_usage_hints: 0,
                video_content_hints: 0,
                tuning_mode: 0,
            }),
            codec: Box::new(VkVideoEncodeCodecProfileInfo {
                s_type,
                p_next: std::ptr::null(),
                std_profile: std_profil,
            }),
            profil: Box::new(VkVideoProfileInfoKHR {
                s_type: VK_STRUCTURE_TYPE_VIDEO_PROFILE_INFO_KHR,
                p_next: std::ptr::null(),
                video_codec_operation: op,
                chroma_subsampling: VK_VIDEO_CHROMA_SUBSAMPLING_420_BIT_KHR,
                luma_bit_depth: tiefe,
                chroma_bit_depth: tiefe,
            }),
            liste: Box::new(VkVideoProfileListInfoKHR {
                s_type: VK_STRUCTURE_TYPE_VIDEO_PROFILE_LIST_INFO_KHR,
                p_next: std::ptr::null(),
                profile_count: 1,
                p_profiles: std::ptr::null(),
            }),
        }
    }

    /// Verknüpft die Kette und liefert den Kopf für `VkImageCreateInfo::pNext`.
    ///
    /// Die Verknüpfung passiert hier und nicht in `neu`, weil `Box`-Adressen
    /// erst nach dem Anlegen feststehen — und weil die Kette dann in genau
    /// einer Funktion steht statt über zwei verteilt.
    ///
    /// # Safety
    ///
    /// Der zurückgegebene Zeiger ist nur gültig, solange `self` lebt und nicht
    /// verändert wird.
    pub(super) fn kette(&mut self) -> *const c_void {
        self.codec.p_next = &*self.nutzung as *const _ as *const c_void;
        self.profil.p_next = &*self.codec as *const _ as *const c_void;
        self.liste.p_profiles = &*self.profil as *const VkVideoProfileInfoKHR;
        &*self.liste as *const _ as *const c_void
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Die Bittiefe MUSS im Profil ankommen — sie ist der ganze Grund, warum es
    /// das hier gibt.
    #[test]
    fn bittiefe_landet_im_profil() {
        let acht = Videoprofil::neu(Videocodec::Av1, false);
        let zehn = Videoprofil::neu(Videocodec::Av1, true);
        assert_eq!(acht.profil.luma_bit_depth, VK_VIDEO_COMPONENT_BIT_DEPTH_8_BIT_KHR);
        assert_eq!(zehn.profil.luma_bit_depth, VK_VIDEO_COMPONENT_BIT_DEPTH_10_BIT_KHR);
        // Chroma muss mitziehen; ein Profil mit 10 bit Luma und 8 bit Chroma
        // waere genau die Sorte Halbheit, die den Fehler wieder einbaut.
        assert_eq!(zehn.profil.chroma_bit_depth, zehn.profil.luma_bit_depth);
    }

    /// Der Codec entscheidet ueber zwei Felder zugleich — Operation und
    /// `sType` der Codec-Struktur. Laufen die auseinander, liest der Treiber
    /// die falsche Struktur.
    #[test]
    fn codec_setzt_operation_und_stype_zusammen() {
        let av1 = Videoprofil::neu(Videocodec::Av1, false);
        assert_eq!(av1.profil.video_codec_operation, VK_VIDEO_CODEC_OPERATION_ENCODE_AV1_BIT_KHR);
        assert_eq!(av1.codec.s_type, VK_STRUCTURE_TYPE_VIDEO_ENCODE_AV1_PROFILE_INFO_KHR);
        let h264 = Videoprofil::neu(Videocodec::H264, false);
        assert_eq!(h264.profil.video_codec_operation, VK_VIDEO_CODEC_OPERATION_ENCODE_H264_BIT_KHR);
        assert_eq!(h264.codec.s_type, VK_STRUCTURE_TYPE_VIDEO_ENCODE_H264_PROFILE_INFO_KHR);
    }

    /// Die Kette muss vollstaendig verknuepft sein — ein fehlendes Glied ist
    /// ein Nullzeiger mitten in einer Struktur, die der Treiber durchlaeuft.
    #[test]
    fn kette_ist_vollstaendig_verknuepft() {
        let mut p = Videoprofil::neu(Videocodec::Av1, true);
        let kopf = p.kette();
        assert_eq!(kopf, &*p.liste as *const _ as *const c_void);
        assert_eq!(p.liste.p_profiles, &*p.profil as *const _);
        assert_eq!(p.profil.p_next, &*p.codec as *const _ as *const c_void);
        assert_eq!(p.codec.p_next, &*p.nutzung as *const _ as *const c_void);
        assert!(p.nutzung.p_next.is_null(), "die Kette endet bei der Nutzung");
    }
}
