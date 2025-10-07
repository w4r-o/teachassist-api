import type { NextApiRequest, NextApiResponse } from "next";
import cheerio from "cheerio";
import Cors from "cors";
// @ts-expect-error
import { fetch as cookieFetch, CookieJar } from "node-fetch-cookies";

interface Course {
  code: string;
  name: string;
  block: string;
  room: string;
  start_time: string;
  end_time: string;
  dropped_time: string;
  overall_mark: number | "N/A";
  isFinal: boolean;
  isMidterm: boolean;
  link: string | undefined;
  assignments: Assignment[];
  weight_table: WeightTable;
}

interface Assignment {
  name: string;
  feedback?: string;
  KU?: Mark[];
  A?: Mark[];
  T?: Mark[];
  C?: Mark[];
  O?: Mark[];
  F?: Mark[];
}

interface Mark {
  get: number;
  total: number;
  weight: number;
  finished: boolean;
}

interface WeightTable {
  [key: string]: {
    W: number;
    CW: number;
    SA: number;
  };
}

const cors = Cors({
  methods: ["POST"],
});

function runMiddleware(req: NextApiRequest, res: NextApiResponse, fn: typeof cors) {
  return new Promise((resolve, reject) => {
    fn(req, res, (result: unknown) => {
      if (result instanceof Error) {
        return reject(result);
      }
      return resolve(result);
    });
  });
}

function parseOverallMark(mark: string): { mark: number | "N/A"; isFinal: boolean; isMidterm: boolean } {
  mark = mark.replaceAll(" ", "");
  const result = {
    mark: "N/A" as number | "N/A",
    isFinal: false,
    isMidterm: false,
  };

  if (mark.includes("FINAL")) {
    result.mark = parseFloat(mark.split("FINALMARK:")[1].split("%")[0]);
    result.isFinal = true;
  } else if (mark.includes("currentmark")) {
    result.mark = parseFloat(mark.split("currentmark=")[1].split("%")[0]);
  } else if (mark.includes("MIDTERM")) {
    result.mark = parseFloat(mark.split("MIDTERMMARK:")[1].split("%")[0]);
    result.isMidterm = true;
  }
  return result;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  await runMiddleware(req, res, cors);

  const { username, password } = req.body;

  const cookieJar = new CookieJar();

  if (!username || !password) {
    return res.status(400).json({ response: { error: "Invalid username or password" } });
  }

  if (req.method === "POST") {
    try {
      const data = await cookieFetch(
        cookieJar,
        `https://ta.yrdsb.ca/live/index.php?username=${username as string}&password=${password as string}&submit=Login&subject_id=0`,
        {
          method: "POST",
          body: "credentials",
        }
      );
      const textData = await data.text();

      if (textData.includes("Invalid Login")) {
        return res.status(401).json({ response: { error: "Invalid Login" } });
      } else if (textData.includes("Access Denied")) {
        return res.status(403).json({ response: { error: "Access Denied" } });
      } else if (textData.includes("Session Expired")) {
        return res.status(401).json({ response: { error: "Session Expired" } });
      }

      const $ = cheerio.load(textData);
      const courses: Course[] = [];
      $(".green_border_message div table tr").each(
        (i, elem) => {
          try {
            const link = $(elem).find("a").attr("href");
            const courseText = $(elem).text().split("\n");
            if (!courseText[1].includes("Course Name")) {
              const filteredCourse = courseText
                .map((item) => item.trim())
                .filter((item) => item.length > 0);

              if (filteredCourse.length > 3) {
                const overall = parseOverallMark(filteredCourse[4] || "");
                let end_time = "";
                let dropped_time = "";
                if (filteredCourse[3].includes("Dropped on")) {
                  end_time = filteredCourse[3].split("Dropped")[0].trim();
                  dropped_time = filteredCourse[3].split("Dropped on")[1].trim();
                } else {
                  end_time = filteredCourse[3].trim();
                }
                const jsonCourse: Course = {
                  code: filteredCourse[0].split(" : ")[0] || "Unknown Code",
                  name: filteredCourse[0].split(" : ")[1] || "Unknown Course",
                  block: filteredCourse[1].replace("Block: P", "").split(" ")[0] || "N/A",
                  room: filteredCourse[1].split("rm. ")[1] || "Unknown Room",
                  start_time: filteredCourse[2].split(" ")[0] || "",
                  end_time: end_time,
                  dropped_time: dropped_time,
                  overall_mark: overall.mark || "N/A",
                  isFinal: overall.isFinal,
                  isMidterm: overall.isMidterm,
                  link: link,
                  assignments: [],
                  weight_table: {},
                };
                courses.push(jsonCourse);
              }
            }
          } catch (err) {
            console.log(err);
          }
        }
      );

      for (let i = 0; i < courses.length; i++) {
        const courseRes = await cookieFetch(
          cookieJar,
          "https://ta.yrdsb.ca/live/students/" + (courses[i].link as string),
          {
            method: "POST",
            body: "credentials",
          }
        );
        const courseText = await courseRes.text();
        const $ = cheerio.load(courseText);

        const assignments: Assignment[] = [];
        let counter = 1;
        $('table[width="100%"]').children().children().each((i, elem) => {
          counter++;
          if (counter % 2 === 0) {
            if (counter > 2) {
              assignments[assignments.length - 1].feedback = $(elem).text().trim();
            }
            return;
          }

          const assignment: Assignment = {
            name: $(elem).find('td[rowspan="2"]').text().replaceAll("\t", ""),
          };
          [
            ["KU", "ffffaa"], ["A", "ffd490"], ["T", "c0fea4"],
            ["C", "afafff"], ["O", "eeeeee"], ["F", "#dedede"],
          ].forEach((item) => {
            const category = $(elem).find(`td[bgcolor="${item[1]}"]`).text().replaceAll("\t", "").trim();
            if (category) {
              try {
                (assignment as any)[item[0]] = [{
                  get: parseFloat(category.split(" / ")[0]),
                  total: parseFloat(category.split(" / ")[1].split(" = ")[0]),
                  weight: parseFloat(category.split("weight=")[1].split("\n")[0]),
                  finished: !category.includes("finished"),
                }];
              } catch (e) {
                (assignment as any)[item[0]] = [{ get: 0, total: 0, weight: 0, finished: true }];
              }
            }
          });
          assignments.push(assignment);
        });

        const weight_table: WeightTable = {};
        [
          ["KU", "ffffaa"], ["A", "ffd490"], ["T", "c0fea4"],
          ["C", "afafff"], ["O", "eeeeee"], ["F", "cccccc"],
        ].forEach((item) => {
          const weights: string[] = [];
          $('table[cellpadding="5"]').find(`tr[bgcolor="#${item[1]}"]`).children().each((i, elem) => {
            weights.push($(elem).text().trim());
          });
          try {
            let index = 1;
            if (weights[0]?.includes("Final")) {
              index = 0;
              weights[index] = "0%";
            }
            weight_table[item[0]] = {
              W: parseFloat(weights[index].replace("%", "")),
              CW: parseFloat(weights[index + 1].replace("%", "")),
              SA: parseFloat(weights[index + 2].replace("%", "")),
            };
          } catch (err) {
            return;
          }
        });

        courses[i].assignments = assignments.length > 0 ? [...assignments] : [];
        courses[i].weight_table = Object.keys(weight_table).length > 0 ? { ...weight_table } : {};
      }

      return res.status(200).json({ response: courses });
    } catch (err) {
      const error = err as Error;
      return res.status(500).json({
        response: { error: error.message },
      });
    }
  }
}
