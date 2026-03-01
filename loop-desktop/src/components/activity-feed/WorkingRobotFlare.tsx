import { memo, useEffect, useRef } from 'react';

const EYE_TRACK_LIMIT = 3.2;
const EYE_TRACK_DISTANCE_DIVISOR = 22;

export const WorkingRobotFlare = memo(function WorkingRobotFlare() {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const eyeGroupRef = useRef<SVGGElement | null>(null);

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent): void => {
      const svg = svgRef.current;
      const eyeGroup = eyeGroupRef.current;
      if (!svg || !eyeGroup) {
        return;
      }

      const rect = svg.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      const mouseX = event.clientX - centerX;
      const mouseY = event.clientY - centerY;
      const angle = Math.atan2(mouseY, mouseX);
      const distance = Math.min(
        EYE_TRACK_LIMIT,
        Math.hypot(mouseX, mouseY) / EYE_TRACK_DISTANCE_DIVISOR,
      );

      const translateX = Math.cos(angle) * distance;
      const translateY = Math.sin(angle) * distance;
      eyeGroup.style.transform = `translate(${translateX}px, ${translateY}px)`;
    };

    document.addEventListener('mousemove', handleMouseMove);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
    };
  }, []);

  return (
    <div className="pointer-events-none select-none opacity-50">
      <svg
        ref={svgRef}
        width="48"
        height="48"
        viewBox="0 0 100 100"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <style>
          {`
            @keyframes working-robot-float {
              0%, 100% { transform: translateY(0px); }
              50% { transform: translateY(4px); }
            }

            @keyframes working-robot-blink {
              0%, 90%, 100% { transform: scaleY(1); }
              95% { transform: scaleY(0.12); }
            }

            @keyframes working-robot-pulse {
              0%, 100% { opacity: 1; }
              50% { opacity: 0.5; }
            }

            .working-robot-head {
              animation: working-robot-float 3s ease-in-out infinite;
              transform-origin: center;
            }

            .working-robot-eye {
              fill: #d4d4d4;
              animation: working-robot-blink 4s infinite;
              transform-origin: center;
              transform-box: fill-box;
            }

            .working-robot-antenna-light {
              animation: working-robot-pulse 2s step-end infinite;
            }
          `}
        </style>

        <g className="working-robot-head">
          <rect x="47" y="5" width="6" height="12" rx="1" fill="#404040" />
          <rect
            className="working-robot-antenna-light"
            x="43"
            y="2"
            width="14"
            height="6"
            rx="1"
            fill="#525252"
          />

          <rect
            x="20"
            y="20"
            width="60"
            height="55"
            rx="12"
            fill="#f2f2f2"
            stroke="#050505"
            strokeWidth="3"
          />
          <rect x="28" y="28" width="44" height="38" rx="8" fill="#171717" />

          <g ref={eyeGroupRef}>
            <rect className="working-robot-eye" x="36" y="44" width="8" height="12" rx="4" />
            <rect className="working-robot-eye" x="56" y="44" width="8" height="12" rx="4" />
          </g>

          <rect x="14" y="38" width="6" height="20" rx="2" fill="#404040" />
          <rect x="80" y="38" width="6" height="20" rx="2" fill="#404040" />
        </g>
      </svg>
    </div>
  );
});
